import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { TimestampSchema } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError } from "@connectrpc/connect";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DeviceKind,
  DevicePeerCapabilityKind,
  DevicePeerDescriptorSchema,
  DevicePeerRouteIdentitySchema,
  DevicePeerWorkspaceLocationSchema,
  DevicePresenceState,
  RemoteDesktopCapabilitiesSchema,
  RemoteDesktopClipboardContentResultSchema,
  RemoteDesktopClipboardTextResultSchema,
  RemoteDesktopClipboardSyncResultSchema,
  RemoteDesktopClipboardVersionResultSchema,
  RemoteDesktopControlStateSchema,
  RemoteDesktopCursorSchema,
  RemoteDesktopDisplayModeSchema,
  RemoteDesktopDisplayModeResultSchema,
  RemoteDesktopViewerDisplayResultSchema,
  RemoteDesktopDisplaySchema,
  RemoteDesktopFailureReason,
  RemoteDesktopFailureSchema,
  RemoteDesktopFrameSchema,
  RemoteDesktopFrameResultSchema,
  RemoteDesktopHostMuteResultSchema,
  RemoteDesktopPrivacyScreenResultSchema,
  RemoteDesktopCredentialResultSchema,
  RemoteDesktopLockState,
  RemoteDesktopIceServerSchema,
  RemoteDesktopLeaseSchema,
  RemoteDesktopPermissionStatus,
  RemoteDesktopPermissionsSchema,
  RemoteDesktopStartMode,
  StopRemoteDesktopRequestSchema,
  StopRemoteDesktopResponseSchema,
  RemoteDesktopVideoQuality,
  RevisionSchema,
  SessionSchema,
  TargetSchema,
  WorkspaceLocationSchema,
  type RemoteDesktopClipboardContentResult,
  type RemoteDesktopControlState,
  type RemoteDesktopPermissions
} from "@joko/contracts";
import { mobileNetwork, mobileRemoteDesktopNetworkTesting, type PairedCredential } from "./network";
import { createMobileRemoteDesktopHostMutePreferenceStore,
  type MobileRemoteDesktopHostMutePreferences } from "./mobile-remote-desktop-host-mute-preference";
import { createMobileRemoteDesktopLockPreferenceStore } from "./mobile-remote-desktop-lock-preference";
import { createMobileRemoteDesktopClipboardSyncPreferenceStore } from "./mobile-remote-desktop-clipboard-sync-preference";
import { createMobileRemoteDesktopPrivacyPreferenceStore, type MobileRemoteDesktopPrivacyPreferences } from "./mobile-remote-desktop-privacy-preference";
import { MobileAppLifecycleCoordinator } from "./mobile-app-lifecycle";
import {
  MOBILE_REMOTE_DESKTOP_LEASE_MS,
  MobileRemoteDesktopController,
  mobileRemoteDesktopTesting,
  type MobileRemoteDesktopTransport
} from "./remote-desktop-controller";
import { mobileRemoteDesktopViewerTesting, remoteDesktopViewerHtml } from "./remote-desktop-viewer";
import {
  mobileRemoteDesktopCopy,
  mobileRemoteDesktopStatusLabel,
  mobileRemoteDesktopClipboardNoticeLabel,
  mobileRemoteDesktopNoticeLabel,
  mobileRemoteDesktopSessionDeviceId
} from "./remote-desktop-presentation";
import {
  MOBILE_REMOTE_CLIPBOARD_TRANSFER_MS,
  MobileRemoteClipboardError,
  type MobileRemoteClipboardSystem
} from "./mobile-remote-desktop-clipboard";
import type { MobileRemoteDesktopCredentialsNative } from "./mobile-remote-desktop-credentials-native";
import { mobileRemoteDesktopKeyPages, mobileRemoteDesktopModifiers, type MobileRemoteDesktopKeyCode } from "./remote-desktop-keyboard";
import { parseMobileRemoteDesktopNativeCommand, type MobileRemoteDesktopNativeInputBatch } from "./remote-desktop-native-bridge";

afterEach(() => {
  vi.useRealTimers();
});

function fixture(webrtcVideo = true, controlling = false, mediaFeatures = false, rd01Features = false) {
  const targetRevision = create(RevisionSchema, { value: 1n, etag: "target" });
  const relationRevision = create(RevisionSchema, { value: 0n, etag: "relation" });
  const route = create(DevicePeerRouteIdentitySchema, {
    targetDeviceId: "desktop-1", relationId: "relation-1", targetDeviceRevision: targetRevision,
    relationRevision, routeGeneration: 1n
  });
  const host = create(DevicePeerDescriptorSchema, {
    route, displayName: "Desk", kind: DeviceKind.DESKTOP, platform: "darwin",
    presence: DevicePresenceState.ONLINE, capabilities: [DevicePeerCapabilityKind.REMOTE_DESKTOP]
  });
  const permissions = create(RemoteDesktopPermissionsSchema, {
    screenRecording: RemoteDesktopPermissionStatus.GRANTED,
    accessibility: RemoteDesktopPermissionStatus.GRANTED
  });
  const display = create(RemoteDesktopDisplaySchema, { displayId: "display-1", name: "Built-in", width: 1920, height: 1080 });
  const capabilities = create(RemoteDesktopCapabilitiesSchema, {
    protocolVersion: 1, enabled: true, canControl: true, platform: "darwin", displays: [display], permissions,
    automaticReconnect: true, connectionTakeover: true, webrtcVideo, trickleIce: true, jpegFallback: true,
    clipboardText: true, clipboardContent: true, videoSettings: mediaFeatures,
    systemAudio: mediaFeatures, backgroundViewing: mediaFeatures,
    displayModes: rd01Features, cursorOverlay: rd01Features, hostMute: rd01Features, lockOnExit: rd01Features,
    clipboardSync: rd01Features, clipboardInline: rd01Features, privacyScreen: rd01Features
  });
  const lease = create(RemoteDesktopLeaseSchema, {
    leaseId: "lease-1", display, controlling, controlGeneration: 1n
  });
  const start = vi.fn<MobileRemoteDesktopTransport["start"]>(async () => lease);
  const heartbeat = vi.fn<MobileRemoteDesktopTransport["heartbeat"]>(async () =>
    create(RemoteDesktopControlStateSchema, { controlling: false, controlGeneration: 1n }));
  const stop = vi.fn<MobileRemoteDesktopTransport["stop"]>(async () => undefined);
  const control = vi.fn<MobileRemoteDesktopTransport["control"]>(async (_host, _leaseId, enabled) =>
    create(RemoteDesktopControlStateSchema, { controlling: enabled, controlGeneration: 1n }));
  const presentation = vi.fn<MobileRemoteDesktopTransport["presentation"]>(async () =>
    create(RemoteDesktopControlStateSchema, { controlling: false, controlGeneration: 1n }));
  const input = vi.fn<MobileRemoteDesktopTransport["input"]>(async () => undefined);
  const offer = vi.fn<MobileRemoteDesktopTransport["offer"]>(async (_host, _leaseId, attemptId) => ({
    $typeName: "joko.v1.RemoteDesktopOfferResult" as const, attemptId, answerSdp: "answer"
  }));
  const frame = vi.fn<MobileRemoteDesktopTransport["frame"]>(async () => create(RemoteDesktopFrameResultSchema, {}));
  const listDisplayModes = vi.fn<MobileRemoteDesktopTransport["listDisplayModes"]>(async () => [
    create(RemoteDesktopDisplayModeSchema, {
      modeId: "10", width: 1920, height: 1080, current: true, native: true
    }),
    create(RemoteDesktopDisplayModeSchema, {
      modeId: "20", width: 1280, height: 720, current: false, native: false
    })
  ]);
  const setDisplayMode = vi.fn<MobileRemoteDesktopTransport["setDisplayMode"]>(async () => create(RemoteDesktopDisplayModeResultSchema, {}));
  const fitViewerDisplay = vi.fn<NonNullable<MobileRemoteDesktopTransport["fitViewerDisplay"]>>(async () => create(RemoteDesktopViewerDisplayResultSchema, {}));
  const restoreViewerDisplay = vi.fn<NonNullable<MobileRemoteDesktopTransport["restoreViewerDisplay"]>>(async () => create(RemoteDesktopViewerDisplayResultSchema, {}));
  const systemAction = vi.fn<MobileRemoteDesktopTransport["systemAction"]>(async (_host, _leaseId, _controlGeneration, action) => action);
  const setHostMute = vi.fn<MobileRemoteDesktopTransport["setHostMute"]>(async (_host, _lease, _generation, enabled) =>
    create(RemoteDesktopHostMuteResultSchema, { enabled }));
  const setPrivacyScreen = vi.fn<MobileRemoteDesktopTransport["setPrivacyScreen"]>(async (_host, _lease, _generation, enabled) =>
    create(RemoteDesktopPrivacyScreenResultSchema, { enabled }));
  const clipboardText = vi.fn<MobileRemoteDesktopTransport["clipboardText"]>(async () =>
    create(RemoteDesktopClipboardTextResultSchema, {}));
  const clipboardContent = vi.fn<MobileRemoteDesktopTransport["clipboardContent"]>(async () =>
    create(RemoteDesktopClipboardContentResultSchema, {}));
  const setClipboardSync = vi.fn<MobileRemoteDesktopTransport["setClipboardSync"]>(async (_host, request) =>
    create(RemoteDesktopClipboardSyncResultSchema, { enabled: request.enabled, syncGeneration: 1n }));
  const clipboardVersion = vi.fn<MobileRemoteDesktopTransport["clipboardVersion"]>(async () =>
    create(RemoteDesktopClipboardVersionResultSchema, { version: "1" }));
  const transport: MobileRemoteDesktopTransport = {
    ownerKey: "owner-1", isCurrent: () => true, canStop: () => true,
    preferenceOwner: { profileId: "profile-1", serverId: "server-1", controllerDeviceId: "phone-1" },
    listHosts: vi.fn(async () => [host]), capabilities: vi.fn(async () => capabilities),
    permissions: vi.fn(async () => permissions), showPermissionGuide: vi.fn(async () => permissions),
    start, heartbeat, stop, control, presentation, input, systemAction, iceConfiguration: vi.fn(async () => []),
    offer, ice: vi.fn(async (_host, _leaseId, attemptId, candidates, after) => ({
      $typeName: "joko.v1.RemoteDesktopIceExchangeResult" as const,
      attemptId, candidates: [...candidates], next: after + candidates.length, complete: true
    })), frame, listDisplayModes, setDisplayMode, fitViewerDisplay, restoreViewerDisplay, setHostMute, setPrivacyScreen, clipboardText, clipboardContent, setClipboardSync, clipboardVersion
  };
  return { route, host, capabilities, transport, start, heartbeat, stop, control, presentation, input, systemAction, offer, frame,
    listDisplayModes, setDisplayMode, fitViewerDisplay, restoreViewerDisplay, setHostMute, setPrivacyScreen, clipboardText, clipboardContent, setClipboardSync, clipboardVersion, lease };
}

let syncLocalEpoch = 0;
describe("Mobile captured Fold touchpad and local viewport", () => {
  const labels = { left: "Left", right: "Right", wheel: "Wheel" };
  async function touchFixture() {
    const value = fixture(true, true, true);
    value.heartbeat.mockResolvedValue(create(RemoteDesktopControlStateSchema, { controlling: true, controlGeneration: 1n }));
    const controller = new MobileRemoteDesktopController(value.transport), commands: Record<string, unknown>[] = [];
    controller.setViewerSink(command => commands.push({ ...command }));
    controller.configureMouseControls(false, true, labels);
    controller.configureViewport({ fitToInsets: true, topInset: 100, bottomInset: 400 });
    await controller.open(); controller.viewerMessage({ type: "ready" }); await flushAsync();
    const epoch = commands.findLast(command => command.type === "init")!.epoch as string;
    controller.viewerMessage({ type: "iceConfig", epoch, attemptId: "fold" });
    controller.viewerMessage({ type: "streaming", epoch, attemptId: "fold" }); await flushAsync();
    return { ...value, controller, commands, epoch };
  }

  it("preserves desired local viewport through init and captures one immutable full-authority gesture without enabling mouse intent", async () => {
    const value = await touchFixture();
    expect(value.controller.snapshot).toMatchObject({ mouseButtons: false, touchpadOccurrence: 0 });
    expect(value.commands.findLast(command => command.type === "viewport")).toEqual({
      type: "viewport", epoch: value.epoch, fitToInsets: true, topInset: 100, bottomInset: 400 });
    const grant = value.controller.beginTouchpad()!;
    expect(Object.isFrozen(grant)).toBe(true); expect(value.controller.beginTouchpad()).toBeUndefined();
    value.controller.moveTouchpad({ ...grant }, 10, 20); value.controller.moveTouchpad(grant, Number.NaN, 1);
    value.controller.moveTouchpad(grant, 30, -10); value.controller.endTouchpad(grant, true);
    expect(value.commands.filter(command => command.type === "nativeTouchpad")).toEqual([
      { type: "nativeTouchpad", epoch: value.epoch, id: grant.id, event: "start" },
      { type: "nativeTouchpad", epoch: value.epoch, id: grant.id, event: "move", dx: 30, dy: -10 },
      { type: "nativeTouchpad", epoch: value.epoch, id: grant.id, event: "end", tap: true }
    ]);
    const count = value.commands.length; value.controller.endTouchpad(grant, true); expect(value.commands).toHaveLength(count);
    await value.controller.close();
  });

  it("ignores malformed viewport updates and preserves a captured gesture on identical layouts and heartbeats", async () => {
    vi.useFakeTimers(); const value = await touchFixture(); const grant = value.controller.beginTouchpad()!;
    const count = value.commands.length;
    value.controller.configureViewport({ fitToInsets: true, topInset: 100, bottomInset: 400 });
    value.controller.configureViewport({ fitToInsets: true, topInset: -1, bottomInset: 400 });
    value.controller.configureViewport({ fitToInsets: true, topInset: 100, bottomInset: Number.NaN });
    value.controller.configureViewport({ fitToInsets: true, topInset: 100, bottomInset: 400, extra: true } as never);
    expect(value.commands).toHaveLength(count); await vi.advanceTimersByTimeAsync(3_000);
    expect(value.controller.snapshot.touchpadOccurrence).toBe(grant.occurrence);
    value.controller.endTouchpad(grant); expect(value.commands.findLast(command => command.type === "nativeTouchpad")).toMatchObject({ event: "end", tap: false });
    await value.controller.close();
  });

  it("cancels only the original current gesture and retires captured held mouse ownership with its release", async () => {
    const value = await touchFixture(); value.controller.configureMouseControls(true, true, labels);
    const mouse = value.controller.beginMouseControl("left")!, grant = value.controller.beginTouchpad()!;
    value.controller.endTouchpad(grant, false, true);
    expect(value.commands.filter(command => command.type === "nativeMouse").at(-1)).toMatchObject({ event: "pointercancel" });
    expect(value.commands.filter(command => command.type === "nativeTouchpad").at(-1)).toMatchObject({ epoch: value.epoch, id: grant.id, event: "cancel" });
    const count = value.commands.length; value.controller.endMouseControl(mouse); value.controller.endTouchpad(grant, true);
    expect(value.commands).toHaveLength(count); await value.controller.close();
  });

  it.each(["layout", "keyboard", "mode", "route", "interactive", "foreground", "control", "generation", "viewer", "owner", "stop"] as const)(
    "retires captured relative gesture at %s without late movement or tap reaching replacement", async boundary => {
      vi.useFakeTimers(); const value = await touchFixture(); const grant = value.controller.beginTouchpad()!;
      if (boundary === "layout") value.controller.configureViewport({ fitToInsets: false, topInset: 0, bottomInset: 0 });
      if (boundary === "keyboard") value.controller.showKeyboard();
      if (boundary === "mode") value.controller.setInputMode("trackpad");
      if (boundary === "route") value.controller.setRouteFocused(false);
      if (boundary === "interactive") value.controller.setInteractive(false);
      if (boundary === "foreground") value.controller.setForeground(false);
      if (boundary === "control") await value.controller.setControl(false);
      if (boundary === "generation") {
        value.heartbeat.mockResolvedValue(create(RemoteDesktopControlStateSchema, { controlling: true, controlGeneration: 2n }));
        await vi.advanceTimersByTimeAsync(3_000);
      }
      if (boundary === "viewer") value.controller.viewerMessage({ type: "ready" });
      if (boundary === "owner") { value.transport.isCurrent = () => false; value.controller.authorityChanged(); }
      if (boundary === "stop") await value.controller.close();
      expect(value.controller.snapshot.touchpadOccurrence).toBeGreaterThan(grant.occurrence);
      const count = value.commands.length;
      value.controller.moveTouchpad(grant, 30, 40); value.controller.endTouchpad(grant, true); value.controller.endTouchpad(grant, false, true);
      expect(value.commands).toHaveLength(count);
      expect(value.commands.filter(command => command.type === "nativeTouchpad").every(command => command.epoch === value.epoch)).toBe(true);
      await value.controller.close();
    });

  it("accepts only current strict HTML resize retirement and allows a fresh gesture occurrence", async () => {
    const value = await touchFixture(); const grant = value.controller.beginTouchpad()!;
    value.controller.viewerMessage({ type: "mouseControlsRetired", epoch: "old" });
    value.controller.viewerMessage({ type: "mouseControlsRetired", epoch: value.epoch, extra: true });
    expect(value.controller.snapshot.touchpadOccurrence).toBe(grant.occurrence);
    value.controller.viewerMessage({ type: "mouseControlsRetired", epoch: value.epoch });
    expect(value.controller.snapshot.touchpadOccurrence).toBe(grant.occurrence + 1);
    const next = value.controller.beginTouchpad()!; expect(next.id).not.toBe(grant.id);
    const count = value.commands.length; value.controller.endTouchpad(grant, true); expect(value.commands).toHaveLength(count);
    value.controller.endTouchpad(next, true); await value.controller.close();
  });
});

describe("Mobile floating mouse control grants", () => {
  const labels = { left: "Left mouse", right: "Right mouse", wheel: "Mouse wheel" };
  async function mouseFixture() {
    const value = fixture(true, true, true);
    value.heartbeat.mockResolvedValue(create(RemoteDesktopControlStateSchema, { controlling: true, controlGeneration: 1n }));
    const controller = new MobileRemoteDesktopController(value.transport, undefined, undefined, {
      nativePictureInPicture: true, requiresPlaybackSession: false, playback: async () => undefined
    }), commands: Record<string, unknown>[] = [];
    controller.setViewerSink(command => commands.push({ ...command }));
    controller.configureMouseControls(true, true, labels);
    await controller.open(); controller.viewerMessage({ type: "ready" }); await flushAsync();
    const init = commands.findLast(command => command.type === "init")!, epoch = init.epoch as string;
    controller.viewerMessage({ type: "iceConfig", epoch, attemptId: "mouse" });
    controller.viewerMessage({ type: "streaming", epoch, attemptId: "mouse" }); await flushAsync();
    return { ...value, controller, commands, epoch, init };
  }

  it("defaults off and retains preloaded settings through open while advertising only actual eligibility", async () => {
    const value = fixture(true, true);
    value.heartbeat.mockResolvedValue(create(RemoteDesktopControlStateSchema, { controlling: true, controlGeneration: 1n }));
    const controller = new MobileRemoteDesktopController(value.transport), commands: Record<string, unknown>[] = [];
    controller.setViewerSink(command => commands.push({ ...command }));
    expect(controller.snapshot).toMatchObject({ mouseButtons: false, mouseOccurrence: 0, inputMode: "touch" });
    controller.setInputMode("trackpad"); controller.configureMouseControls(true, true, labels);
    await controller.open(); controller.viewerMessage({ type: "ready" }); await flushAsync();
    expect(controller.snapshot).toMatchObject({ mouseButtons: true, inputMode: "trackpad" });
    expect(commands.findLast(command => command.type === "mouseButtons")).toEqual({ type: "mouseButtons",
      epoch: commands.findLast(command => command.type === "init")!.epoch, enabled: false, nativeControls: true, labels });
    expect(controller.beginMouseControl("left")).toBeUndefined();
    const epoch = commands.findLast(command => command.type === "init")!.epoch;
    controller.viewerMessage({ type: "iceConfig", epoch, attemptId: "settings" });
    controller.viewerMessage({ type: "streaming", epoch, attemptId: "settings" });
    expect(commands.findLast(command => command.type === "mouseButtons")).toMatchObject({ enabled: true });
    controller.showKeyboard(); expect(commands.findLast(command => command.type === "mouseButtons")).toMatchObject({ enabled: false });
    controller.closeKeyboard(); expect(commands.findLast(command => command.type === "mouseButtons")).toMatchObject({ enabled: true });
    await controller.close();
  });

  it("uses immutable original grants for independent left/right/wheel movement and one matching terminal event", async () => {
    const value = await mouseFixture();
    const left = value.controller.beginMouseControl("left", 20)!, right = value.controller.beginMouseControl("right", 30)!, wheel = value.controller.beginMouseControl("wheel", 100)!;
    expect(Object.isFrozen(left)).toBe(true); expect(new Set([left.id, right.id, wheel.id]).size).toBe(3);
    expect(value.controller.beginMouseControl("left")).toBeUndefined();
    value.controller.moveMouseControl({ ...left }, 999); value.controller.endMouseControl({ ...right });
    value.controller.moveMouseControl(left, Number.NaN); value.controller.moveMouseControl(left, 24);
    value.controller.moveMouseControl(wheel, 130); value.controller.endMouseControl(right, true);
    value.controller.endMouseControl(left); value.controller.endMouseControl(left); value.controller.endMouseControl(wheel);
    expect(value.commands.filter(command => command.type === "nativeMouse")).toEqual([
      { type: "nativeMouse", epoch: value.epoch, control: "left", event: "pointerdown", id: 0, y: 20 },
      { type: "nativeMouse", epoch: value.epoch, control: "right", event: "pointerdown", id: 0, y: 30 },
      { type: "nativeMouse", epoch: value.epoch, control: "wheel", event: "pointerdown", id: 0, y: 100 },
      { type: "nativeMouse", epoch: value.epoch, control: "left", event: "pointermove", id: 0, y: 24 },
      { type: "nativeMouse", epoch: value.epoch, control: "wheel", event: "pointermove", id: 0, y: 130 },
      { type: "nativeMouse", epoch: value.epoch, control: "right", event: "pointercancel", id: 0, y: 30 },
      { type: "nativeMouse", epoch: value.epoch, control: "left", event: "pointerup", id: 0, y: 24 },
      { type: "nativeMouse", epoch: value.epoch, control: "wheel", event: "pointerup", id: 0, y: 130 }
    ]);
    await value.controller.close();
  });

  it("limits accessibility activation to a current unheld control and rejects malformed configuration", async () => {
    const value = await mouseFixture();
    for (const control of ["left", "right", "wheel"] as const) value.controller.clickMouseControl(control);
    const held = value.controller.beginMouseControl("left")!; value.controller.clickMouseControl("left");
    value.controller.clickMouseControl("unknown" as "left");
    expect(value.commands.filter(command => command.type === "nativeMouse" && command.event === "click")).toHaveLength(3);
    const count = value.commands.length;
    value.controller.configureMouseControls(false, true, { ...labels, wheel: "" });
    value.controller.configureMouseControls(false, true, { ...labels, right: "a".repeat(129) });
    value.controller.beginMouseControl("wheel", Number.POSITIVE_INFINITY);
    expect(value.commands).toHaveLength(count); expect(value.controller.snapshot.mouseButtons).toBe(true);
    value.controller.endMouseControl(held); value.controller.showKeyboard(); value.controller.clickMouseControl("wheel");
    expect(value.commands.filter(command => command.type === "nativeMouse" && command.event === "click")).toHaveLength(3);
    await value.controller.close();
  });

  it.each(["mode", "keyboard", "setting", "route", "interactive", "foreground", "control", "generation", "display", "owner", "viewer", "stop", "pip"] as const)(
    "retires captured gestures at the %s boundary and ignores late callbacks", async boundary => {
      vi.useFakeTimers(); const value = await mouseFixture();
      const grant = value.controller.beginMouseControl("left", 50)!, wheel = value.controller.beginMouseControl("wheel", 80)!;
      const occurrence = value.controller.snapshot.mouseOccurrence;
      if (boundary === "mode") value.controller.setInputMode("trackpad");
      if (boundary === "keyboard") value.controller.showKeyboard();
      if (boundary === "setting") value.controller.configureMouseControls(false, true, labels);
      if (boundary === "route") value.controller.setRouteFocused(false);
      if (boundary === "interactive") value.controller.setInteractive(false);
      if (boundary === "foreground") value.controller.setForeground(false);
      if (boundary === "control") await value.controller.setControl(false);
      if (boundary === "generation") {
        value.heartbeat.mockResolvedValue(create(RemoteDesktopControlStateSchema, { controlling: true, controlGeneration: 2n }));
        await vi.advanceTimersByTimeAsync(3_000);
      }
      if (boundary === "display") {
        const display = create(RemoteDesktopDisplaySchema, { ...value.lease.display!, displayId: "display-2" });
        value.capabilities.displays.push(display);
        value.start.mockResolvedValue(create(RemoteDesktopLeaseSchema, { ...value.lease, leaseId: "lease-2", display }));
        await value.controller.selectDisplay("display-2");
      }
      if (boundary === "owner") { value.transport.isCurrent = () => false; value.controller.authorityChanged(); }
      if (boundary === "viewer") value.controller.viewerMessage({ type: "ready" });
      if (boundary === "stop") await value.controller.close();
      if (boundary === "pip") {
        value.controller.viewerMessage({ type: "pipCapability", epoch: value.epoch, supported: true });
        await value.controller.startPictureInPicture();
      }
      await flushAsync();
      expect(value.controller.snapshot.mouseOccurrence).toBeGreaterThan(occurrence);
      const count = value.commands.length;
      value.controller.moveMouseControl(grant, 500); value.controller.endMouseControl(grant);
      value.controller.moveMouseControl(wheel, 500); value.controller.endMouseControl(wheel, true);
      expect(value.commands).toHaveLength(count);
      expect(value.commands.filter(command => command.type === "nativeMouse").every(command => command.epoch === value.epoch)).toBe(true);
      await value.controller.close();
    });

  it("clears only current HTML blur/resize grants and publishes an occurrence for the actual native UI to remount", async () => {
    const value = await mouseFixture(); const grant = value.controller.beginMouseControl("left", 42)!;
    const occurrence = value.controller.snapshot.mouseOccurrence;
    value.controller.viewerMessage({ type: "mouseControlsRetired", epoch: "retired" });
    value.controller.viewerMessage({ type: "mouseControlsRetired", epoch: value.epoch, extra: true });
    expect(value.controller.snapshot.mouseOccurrence).toBe(occurrence);
    const count = value.commands.length;
    value.controller.viewerMessage(JSON.stringify({ type: "mouseControlsRetired", epoch: value.epoch }));
    expect(value.controller.snapshot.mouseOccurrence).toBe(occurrence + 1); expect(value.commands).toHaveLength(count);
    value.controller.endMouseControl(grant, true); expect(value.commands).toHaveLength(count);
    const replacement = value.controller.beginMouseControl("left", 60)!;
    expect(replacement.occurrence).toBe(occurrence + 1); expect(replacement.id).not.toBe(grant.id);
    expect(value.commands.at(-1)).toMatchObject({ type: "nativeMouse", event: "pointerdown", y: 60 });
    await value.controller.close();
  });

  it("keeps a held mouse occurrence through unchanged heartbeats and updates translated labels without clearing it", async () => {
    vi.useFakeTimers(); const value = await mouseFixture(); const grant = value.controller.beginMouseControl("left")!;
    const occurrence = value.controller.snapshot.mouseOccurrence;
    await vi.advanceTimersByTimeAsync(3_000);
    value.controller.configureMouseControls(true, true, { left: "Left", right: "Right", wheel: "Wheel" });
    expect(value.controller.snapshot.mouseOccurrence).toBe(occurrence);
    expect(value.commands.findLast(command => command.type === "mouseButtons")).toMatchObject({ enabled: true, labels: { left: "Left", right: "Right", wheel: "Wheel" } });
    value.controller.endMouseControl(grant);
    expect(value.commands.findLast(command => command.type === "nativeMouse")).toMatchObject({ event: "pointerup" }); await value.controller.close();
  });
});

describe("Mobile native media and background presentation", () => {
  const attemptId = "123e4567-e89b-42d3-a456-426614174000";
  const nextAttemptId = "123e4567-e89b-42d3-a456-426614174001";
  async function nativeFixture(controlling = false, frameReady = true, channelRequests = false) {
    const value = fixture(true, controlling, true);
    value.heartbeat.mockResolvedValue(create(RemoteDesktopControlStateSchema, { controlling, controlGeneration: 1n }));
    const ticketClose = vi.fn(), ticketCurrent = vi.fn(() => true);
    value.transport.beginBackgroundTransition = vi.fn(() => ({ isCurrent: ticketCurrent, close: ticketClose }));
    const playback = vi.fn(async (_enabled: boolean) => undefined);
    const sendInput = vi.fn<(batch: MobileRemoteDesktopNativeInputBatch) => Promise<boolean>>(async () => true);
    value.capabilities.channelRequests = channelRequests;
    const sendRequest = vi.fn(async (_request: { readonly epoch: string; readonly attemptId: string; readonly message: { readonly id: string } }) => true);
    const controller = new MobileRemoteDesktopController(value.transport, undefined, undefined, {
      nativeVideo: true, nativePictureInPicture: true, requiresPlaybackSession: true, playback, sendInput, sendRequest
    });
    const commands: Record<string, unknown>[] = [];
    controller.setViewerSink(command => commands.push({ ...command }));
    await controller.open(); controller.viewerMessage({ type: "ready" });
    const init = commands.findLast(command => command.type === "init")!, epoch = init.epoch as string;
    const event = (type: string, extra: Record<string, unknown> = {}) => controller.nativeMessage(JSON.stringify({ type, epoch, attemptId, ...extra }));
    event("iceConfig"); event("pipCapability", { supported: true });
    if (frameReady) event("videoFrameReady");
    event("streaming"); await flushAsync();
    return { ...value, controller, commands, init, epoch, event, playback, sendInput, sendRequest, ticketClose, ticketCurrent };
  }

  it("sends small native control requests over the current media channel and adopts only its matched reply", async () => {
    const value = await nativeFixture(true, true, true); value.control.mockClear();
    let finished = false;
    const pending = value.controller.setControl(false).then(() => { finished = true; }); await flushAsync();
    expect(value.sendRequest).toHaveBeenCalledOnce(); expect(value.control).not.toHaveBeenCalled();
    const request = value.sendRequest.mock.calls[0]![0];
    expect(request).toMatchObject({ epoch: value.epoch, attemptId, message: { type: "request", request: { op: "control", lease: "lease-1", enabled: false } } });
    value.event("channelReply", { attemptId: nextAttemptId, reply: { type: "reply", id: request.message.id, ok: true, result: { controlling: false, controlGeneration: 2 } } });
    expect(finished).toBe(false);
    value.event("channelReply", { reply: { type: "reply", id: request.message.id, ok: true, result: { controlling: false, controlGeneration: 2 } } });
    await pending; expect(value.controller.snapshot.controlling).toBe(false);
    expect(value.control).not.toHaveBeenCalled(); await value.controller.close();
  });

  it("uses the relay only when native media confirms that a request was not sent", async () => {
    const value = await nativeFixture(true, true, true); value.control.mockClear(); value.sendRequest.mockResolvedValueOnce(false);
    await value.controller.setControl(false); expect(value.control).toHaveBeenCalledOnce(); await value.controller.close();
  });

  it("ends an in-flight native request as unknown on media fallback without replaying it on the relay", async () => {
    const value = await nativeFixture(true, true, true); value.control.mockClear();
    const pending = value.controller.setControl(false); await flushAsync();
    value.event("fallback", { reason: "transport", retry: false }); await pending;
    expect(value.control).not.toHaveBeenCalled(); await value.controller.close();
  });

  it("restores a foreground control loss on the same lease, shows progress and respects an explicit view-only choice", async () => {
    vi.useFakeTimers(); const value = await nativeFixture(true); value.control.mockClear();
    value.heartbeat.mockResolvedValue(create(RemoteDesktopControlStateSchema, { controlling: false, controlGeneration: 2n }));
    let finish!: () => void;
    value.control.mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve(create(RemoteDesktopControlStateSchema, { controlling: true, controlGeneration: 3n })); }));
    await vi.advanceTimersByTimeAsync(3_000);
    expect(value.controller.snapshot).toMatchObject({ status: "live", controlling: false, notice: "input-recovering" });
    expect(value.control).toHaveBeenCalledOnce(); expect(value.start).toHaveBeenCalledOnce(); expect(value.stop).not.toHaveBeenCalled();
    finish(); await flushAsync(); expect(value.controller.snapshot).toMatchObject({ controlling: true, notice: undefined });
    value.control.mockResolvedValue(create(RemoteDesktopControlStateSchema, { controlling: false, controlGeneration: 4n }));
    await value.controller.setControl(false);
    value.heartbeat.mockResolvedValue(create(RemoteDesktopControlStateSchema, { controlling: false, controlGeneration: 4n }));
    await vi.advanceTimersByTimeAsync(3_000); expect(value.control).toHaveBeenCalledTimes(2);
    expect(value.controller.snapshot.controlling).toBe(false); await value.controller.close();
  });

  it("requires an actual native frame and keeps HTML media receipts outside native proof", async () => {
    const value = await nativeFixture(false, false);
    expect(value.controller.snapshot).toMatchObject({ media: "webrtc", hasFrame: false, pipAvailable: false, backgroundViewing: false });
    value.controller.viewerMessage({ type: "streaming", epoch: value.epoch, attemptId });
    value.controller.viewerMessage({ type: "pipCapability", epoch: value.epoch, supported: true });
    value.controller.viewerMessage({ type: "presentation", epoch: value.epoch, active: true });
    expect(value.controller.snapshot).toMatchObject({ hasFrame: false, pipAvailable: false, presenting: false });
    value.event("videoFrameReady");
    expect(value.controller.snapshot).toMatchObject({ hasFrame: true, pipAvailable: true });
    expect(value.commands.filter(command => command.type === "nativeVideo")).toEqual([{ type: "nativeVideo", epoch: value.epoch, attemptId }]);
    await value.controller.close();
  });

  it("declares native ownership before the ICE configuration promise and projects strict native commands", async () => {
    const value = await nativeFixture();
    let resolveIce!: (servers: []) => void;
    value.transport.iceConfiguration = vi.fn(() => new Promise<[]>(resolve => { resolveIce = resolve; }));
    value.event("iceConfig", { attemptId: nextAttemptId });
    expect(value.commands.at(-2)?.type === "nativeAttempt" || value.commands.some(command => command.type === "nativeAttempt" && command.attemptId === nextAttemptId)).toBe(true);
    expect(value.commands.filter(command => command.type === "iceConfig").at(-1)?.attemptId).toBe(attemptId);
    resolveIce([]); await flushAsync();
    const { nativeVideo, ...nativeInit } = value.init;
    expect(nativeVideo).toBe(true); expect(parseMobileRemoteDesktopNativeCommand(nativeInit)).toBeDefined();
    expect(parseMobileRemoteDesktopNativeCommand(value.commands.filter(command => command.type === "iceConfig").at(-1))).toBeDefined();
    value.event("ice", { attemptId: nextAttemptId, exchangeId: 1, after: 0,
      candidates: [{ candidate: "candidate:a", sdpMid: "0", sdpMLineIndex: null, usernameFragment: null }] });
    await flushAsync();
    const ice = value.commands.findLast(command => command.type === "ice")!;
    expect(ice).toMatchObject({ error: false, candidates: [{ sdpMid: "0", sdpMLineIndex: null, usernameFragment: null }] });
    expect(parseMobileRemoteDesktopNativeCommand(ice)).toBeDefined();
    await value.controller.close();
  });

  it("reserves Home transition before awaiting and joins early actual PiP with a later host ACK", async () => {
    vi.useFakeTimers();
    const value = await nativeFixture(true);
    let resolveAck!: (state: RemoteDesktopControlState) => void;
    value.presentation.mockImplementationOnce(() => new Promise(resolve => { resolveAck = resolve; }));
    value.controller.setBackgroundViewing(true); value.controller.setInteractive(false);
    expect(value.transport.beginBackgroundTransition).toHaveBeenCalledTimes(1);
    await flushAsync(); expect(value.presentation).toHaveBeenCalledTimes(1);
    value.controller.setForeground(false); value.transport.isCurrent = () => false;
    value.event("presentation", { active: true });
    expect(value.controller.snapshot.presenting).toBe(false);
    expect(value.commands.findLast(command => command.type === "pipPolicy")).toMatchObject({ preparing: true, authorized: false });
    resolveAck(create(RemoteDesktopControlStateSchema, { controlling: false, controlGeneration: 2n }));
    await flushAsync();
    expect(value.controller.snapshot).toMatchObject({ presenting: true, controlling: false, wantedControl: false });
    expect(value.commands.findLast(command => command.type === "pipPolicy")).toMatchObject({ preparing: false, authorized: true });
    expect(value.commands.filter(command => command.type === "presentation" && command.enabled === false)).toHaveLength(0);
    expect(value.ticketClose).toHaveBeenCalled(); expect(value.stop).not.toHaveBeenCalled();
    value.transport.isCurrent = () => true; await value.controller.close();
  });

  it("waits for actual native PiP before Back retains the current route", async () => {
    const value = await nativeFixture(); value.controller.setBackgroundViewing(true);
    let settled = false;
    const leaving = value.controller.leave().then(result => { settled = true; return result; });
    await flushAsync(); expect(settled).toBe(false); expect(value.controller.snapshot.presenting).toBe(false);
    value.controller.viewerMessage({ type: "presentation", epoch: value.epoch, active: true });
    await flushAsync(); expect(settled).toBe(false);
    value.event("presentation", { active: true });
    await expect(leaving).resolves.toBe("retained");
    expect(value.controller.snapshot).toMatchObject({ presenting: true, navigationRetained: true });
    expect(value.stop).not.toHaveBeenCalled(); await value.controller.close();
  });

  it("routes actual restore requests through a numeric current attempt and waits for native inline completion", async () => {
    const value = await nativeFixture(); value.controller.setBackgroundViewing(true);
    const leaving = value.controller.leave(); await flushAsync(); value.event("presentation", { active: true });
    await leaving;
    value.event("presentationRestore", { restoreId: 7, inlineVisible: false, sourceHidden: true });
    expect(value.controller.snapshot.restoreRequest).toBe(`${value.epoch}/${attemptId}/7`);
    expect(value.commands.filter(command => command.type === "restorePresentation")).toHaveLength(0);
    value.controller.setRouteFocused(true);
    expect(value.commands.findLast(command => command.type === "restorePresentation")).toEqual({ type: "restorePresentation", epoch: value.epoch, attemptId, restoreId: 7 });
    expect(value.controller.snapshot.presenting).toBe(true);
    value.event("presentation", { active: false }); await flushAsync();
    expect(value.controller.snapshot).toMatchObject({ presenting: false, controlling: false, wantedControl: false });
    expect(value.controller.snapshot.restoreRequest).toBeUndefined();
    expect(value.presentation.mock.calls.map(call => call[2])).toEqual([true, false]);
    await value.controller.close();
  });

  it.each(["timeout", "disable", "failure", "authority"] as const)("retires the exact lease and native grants on pending %s", async reason => {
    vi.useFakeTimers(); const value = await nativeFixture(true); value.controller.setBackgroundViewing(true);
    const preparing = value.controller.startPictureInPicture(); await flushAsync();
    if (reason === "timeout") await vi.advanceTimersByTimeAsync(4_000);
    else if (reason === "disable") value.controller.setBackgroundViewing(false);
    else if (reason === "failure") value.event("presentationFailed", { reason: "avkit" });
    else value.controller.authorityChanged();
    await flushAsync(); await expect(preparing).resolves.toBe(false);
    expect(value.controller.snapshot.presenting).toBe(false); expect(value.ticketClose).toHaveBeenCalled();
    expect(value.stop).toHaveBeenCalled();
    expect(value.commands.filter(command => command.type === "inputAuthority" && command.grant === null).length).toBeGreaterThan(0);
    expect(value.playback).toHaveBeenLastCalledWith(false); await value.controller.close();
  });

  it.each(["capture-pending", "transport"] as const)("retires actual background PiP and playback on native %s fallback", async reason => {
    const value = await nativeFixture(true); value.controller.setBackgroundViewing(true);
    const preparing = value.controller.startPictureInPicture(); await flushAsync(); value.event("presentation", { active: true });
    await preparing; value.controller.setInteractive(false); value.controller.setForeground(false); value.stop.mockClear();
    value.event("fallback", { reason, retry: true }); await flushAsync();
    expect(value.controller.snapshot).toMatchObject({ presenting: false, controlling: false, media: "none", status: "reconnecting" });
    expect(value.playback).toHaveBeenLastCalledWith(false); expect(value.stop).toHaveBeenCalledTimes(1);
    expect(value.commands.findLast(command => command.type === "inputAuthority")).toMatchObject({ grant: null });
    await value.controller.close();
  });

  it("uses native accepted input exactly once with the complete captured grant", async () => {
    const value = await nativeFixture(true); value.input.mockClear();
    value.controller.viewerMessage({ type: "input", epoch: value.epoch, sequence: 1, events: [{ kind: "key", code: "KeyA", down: true }] });
    await flushAsync();
    expect(value.sendInput).toHaveBeenCalledWith({ epoch: value.epoch, attemptId, controlGeneration: "1",
      sequenceBase: value.init.sequenceBase, sequenceLimit: value.init.sequenceLimit,
      sequence: 1, events: [{ kind: "key", code: "KeyA", down: true }] });
    expect(value.input).not.toHaveBeenCalled();
    expect(value.commands.at(-1)).toEqual({ type: "ack", epoch: value.epoch, sequence: 1 });
    await value.controller.close();
  });

  it("forwards only a current visible strict HTML viewport without adopting it as native media proof", async () => {
    const value = await nativeFixture(false, false);
    const viewport = { type: "nativeViewport", epoch: value.epoch, x: -50, y: 20, width: 800, height: 450, fillHeight: false };
    value.controller.viewerMessage(JSON.stringify(viewport));
    expect(value.commands.at(-1)).toEqual(viewport); expect(value.controller.snapshot.hasFrame).toBe(false);
    const count = value.commands.length;
    value.controller.viewerMessage({ ...viewport, epoch: "retired" });
    value.controller.viewerMessage({ ...viewport, width: Number.NaN });
    value.controller.viewerMessage({ ...viewport, extra: true });
    expect(value.commands).toHaveLength(count);
    value.controller.setRouteFocused(false); const hiddenCount = value.commands.length;
    value.controller.viewerMessage(viewport); expect(value.commands).toHaveLength(hiddenCount);
    await value.controller.close();
  });

  it("delivers ordinary renderer epoch input to RPC without a media attempt and ACKs its own batch", async () => {
    const value = fixture(false, true);
    value.heartbeat.mockResolvedValue(create(RemoteDesktopControlStateSchema, { controlling: true, controlGeneration: 1n }));
    const controller = new MobileRemoteDesktopController(value.transport), commands: Record<string, unknown>[] = [];
    controller.setViewerSink(command => commands.push({ ...command }));
    await controller.open(); controller.viewerMessage({ type: "ready" }); await flushAsync();
    const init = commands.findLast(command => command.type === "init")!;
    controller.viewerMessage(JSON.stringify({ type: "input", epoch: init.epoch, sequence: 1, events: [{ kind: "key", code: "KeyA", down: true }] }));
    await flushAsync(); expect(value.input).toHaveBeenCalledTimes(1);
    expect(commands.at(-1)).toEqual({ type: "ack", epoch: init.epoch, sequence: 1 }); await controller.close();
  });

  it("starts the native overlay JPEG owner when host video is unavailable and measures actual presented frames", async () => {
    vi.useFakeTimers(); const value = fixture(false);
    value.frame.mockResolvedValue(create(RemoteDesktopFrameResultSchema, {
      frame: create(RemoteDesktopFrameSchema, { jpeg: new Uint8Array([1, 2, 3, 4]) })
    }));
    const controller = new MobileRemoteDesktopController(value.transport, undefined, undefined, {
      nativeVideo: true, nativePictureInPicture: true, requiresPlaybackSession: false, playback: async () => undefined
    }), commands: Record<string, unknown>[] = [];
    controller.setViewerSink(command => commands.push({ ...command }));
    await controller.open(); controller.viewerMessage({ type: "ready" }); await flushAsync();
    expect(value.frame).toHaveBeenCalledTimes(1);
    const first = commands.findLast(command => command.type === "frame")!;
    controller.viewerMessage({ type: "framePresented", epoch: first.epoch, frameId: first.frameId, presented: true });
    expect(controller.snapshot.network).toEqual({ transport: "screenshot", bytesPerSecond: null, latencyMs: 0 });
    await vi.advanceTimersByTimeAsync(250);
    const next = commands.findLast(command => command.type === "frame")!;
    expect(next.frameId).not.toBe(first.frameId);
    controller.viewerMessage({ type: "framePresented", epoch: next.epoch, frameId: next.frameId, presented: true });
    expect(controller.snapshot.network).toEqual({ transport: "screenshot", bytesPerSecond: 16, latencyMs: 0 });
    expect(controller.snapshot).toMatchObject({ hasFrame: true, media: "jpeg", pipAvailable: false }); await controller.close();
  });

  it("retires only the JPEG request when the actual native first frame wins before streaming", async () => {
    vi.useFakeTimers(); const value = fixture(true, false, true);
    let resolveFrame!: (frame: ReturnType<typeof create<typeof RemoteDesktopFrameResultSchema>>) => void;
    value.frame.mockImplementationOnce(() => new Promise(resolve => { resolveFrame = resolve; }));
    const controller = new MobileRemoteDesktopController(value.transport, undefined, undefined, {
      nativeVideo: true, nativePictureInPicture: true, requiresPlaybackSession: false, playback: async () => undefined
    }), commands: Record<string, unknown>[] = [];
    controller.setViewerSink(command => commands.push({ ...command }));
    await controller.open(); controller.viewerMessage({ type: "ready" });
    const epoch = commands.findLast(command => command.type === "init")!.epoch;
    const frameSignal = value.frame.mock.calls[0]![3]!;
    controller.nativeMessage(JSON.stringify({ type: "iceConfig", epoch, attemptId }));
    controller.nativeMessage(JSON.stringify({ type: "videoFrameReady", epoch, attemptId }));
    expect(frameSignal.aborted).toBe(true);
    resolveFrame(create(RemoteDesktopFrameResultSchema, { frame: create(RemoteDesktopFrameSchema, { jpeg: new Uint8Array([1, 2, 3]) }) }));
    await flushAsync(); await vi.advanceTimersByTimeAsync(500);
    expect(value.frame).toHaveBeenCalledTimes(1); expect(commands.filter(command => command.type === "frame")).toHaveLength(0);
    expect(commands.filter(command => command.type === "nativeVideo")).toHaveLength(1);
    expect(controller.snapshot).toMatchObject({ media: "webrtc", hasFrame: true });
    expect(value.transport.iceConfiguration).toHaveBeenCalled(); expect(value.stop).not.toHaveBeenCalled(); await controller.close();
  });

  it.each(["throw", "receipt"] as const)("does not replay a native input %s with RPC", async outcome => {
    const value = await nativeFixture(true); value.input.mockClear();
    if (outcome === "throw") value.sendInput.mockRejectedValueOnce(new Error("unknown native receipt"));
    else value.sendInput.mockResolvedValueOnce(undefined as unknown as boolean);
    value.controller.viewerMessage({ type: "input", epoch: value.epoch, sequence: 1, events: [{ kind: "release" }] });
    await flushAsync(); expect(value.input).not.toHaveBeenCalled(); expect(value.stop).toHaveBeenCalled();
    expect(value.controller.snapshot.controlling).toBe(false); await value.controller.close();
  });

  it("falls back once only for a false native receipt in the original control context", async () => {
    const value = await nativeFixture(true); value.sendInput.mockResolvedValueOnce(false); value.input.mockClear();
    value.controller.viewerMessage({ type: "input", epoch: value.epoch, sequence: 1, events: [{ kind: "release" }] });
    await flushAsync(); expect(value.input).toHaveBeenCalledTimes(1);
    expect(value.input).toHaveBeenCalledWith(value.host, value.lease.leaseId, 1n, expect.any(Array), expect.any(AbortSignal));
    expect(value.commands.at(-1)).toEqual({ type: "ack", epoch: value.epoch, sequence: 1 }); await value.controller.close();
  });

  it.each(["attempt", "control", "route", "viewer"] as const)("ignores a late false native input after %s retirement", async retirement => {
    const value = await nativeFixture(true); value.input.mockClear();
    let resolve!: (accepted: boolean) => void;
    value.sendInput.mockImplementationOnce(() => new Promise(receipt => { resolve = receipt; }));
    value.controller.viewerMessage({ type: "input", epoch: value.epoch, sequence: 1, events: [{ kind: "release" }] });
    if (retirement === "attempt") value.event("iceConfig", { attemptId: nextAttemptId });
    else if (retirement === "control") await value.controller.setControl(false);
    else if (retirement === "route") value.controller.setRouteFocused(false);
    else value.controller.viewerMessage({ type: "ready" });
    resolve(false); await flushAsync();
    expect(value.input).not.toHaveBeenCalled();
    expect(value.commands.some(command => command.type === "ack" && command.epoch === value.epoch && command.sequence === 1)).toBe(false);
    await value.controller.close();
  });

  it("keeps fallback, cursor, network and command failures scoped to the current native attempt", async () => {
    const value = await nativeFixture(true);
    value.event("network", { transport: "relay", bytesPerSecond: 4_096, latencyMs: 23 });
    expect(value.controller.snapshot.network).toEqual({ transport: "relay", bytesPerSecond: 4_096, latencyMs: 23 });
    value.event("iceConfig", { attemptId: nextAttemptId });
    const count = value.commands.length;
    value.event("videoFrameReady"); value.event("nativeCursor", { cursor: null });
    value.event("network", { transport: "direct", bytesPerSecond: 99, latencyMs: 1 });
    value.event("fallback", { reason: "transport", retry: true });
    value.controller.nativeCommandFailed({ type: "answer", epoch: value.epoch, attemptId, sdp: "late" });
    expect(value.commands).toHaveLength(count); expect(value.stop).not.toHaveBeenCalled();
    value.event("videoFrameReady", { attemptId: nextAttemptId });
    value.event("streaming", { attemptId: nextAttemptId });
    value.event("reconnecting", { attemptId: nextAttemptId });
    expect(value.commands.findLast(command => command.type === "reconnecting")).toEqual({ type: "reconnecting", epoch: value.epoch, attemptId: nextAttemptId });
    expect(value.commands.findLast(command => command.type === "inputAuthority")).toMatchObject({ grant: null });
    value.event("fallback", { attemptId: nextAttemptId, reason: "transport", retry: true });
    expect(parseMobileRemoteDesktopNativeCommand(value.commands.findLast(command => command.type === "fallback"))).toBeDefined();
    value.controller.nativeCommandFailed({ type: "answer", epoch: value.epoch, attemptId: nextAttemptId, sdp: "current" });
    expect(value.stop).toHaveBeenCalled(); expect(value.controller.snapshot.status).toBe("error");
    await value.controller.close();
  });
});

describe("Mobile remote desktop system actions", () => {
  function systemFixture() {
    const value = fixture(false, true);
    value.host.platform = "linux";
    value.capabilities.platform = "linux";
    value.capabilities.workspaceNavigation = true;
    value.capabilities.systemMenu = true;
    value.heartbeat.mockImplementation(async () => create(RemoteDesktopControlStateSchema, { controlling: true, controlGeneration: 1n }));
    return value;
  }

  it("sends only advertised actions with the current control authority and keeps viewing", async () => {
    vi.useFakeTimers();
    const value = systemFixture(), controller = new MobileRemoteDesktopController(value.transport);
    await controller.open(); await flushAsync();
    for (const action of ["workspaceLeft", "workspaceRight", "systemMenu"] as const) {
      await controller.performSystemAction(action);
      expect(value.systemAction).toHaveBeenLastCalledWith(value.host, value.lease.leaseId, 1n, action, expect.any(AbortSignal));
    }
    expect(controller.snapshot).toMatchObject({ status: "live", controlling: true, systemActionPending: false });
    expect(controller.snapshot.systemActionFailure).toBeUndefined();
    value.capabilities.systemMenu = false;
    await controller.performSystemAction("systemMenu");
    value.capabilities.workspaceNavigation = false;
    await controller.performSystemAction("workspaceLeft");
    expect(value.systemAction).toHaveBeenCalledTimes(3);
    expect(value.start).toHaveBeenCalledOnce(); expect(value.stop).not.toHaveBeenCalled();
    await controller.close();
  });

  it("admits one action, preserves video after failure, and retries only on explicit request", async () => {
    vi.useFakeTimers();
    const value = systemFixture(), controller = new MobileRemoteDesktopController(value.transport);
    let fail!: (error: Error) => void;
    value.systemAction.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
    await controller.open(); await flushAsync();
    const previousMedia = controller.snapshot.media;
    const pending = controller.performSystemAction("workspaceRight"); await flushAsync();
    await controller.performSystemAction("workspaceLeft"); await controller.retrySystemAction();
    expect(value.systemAction).toHaveBeenCalledOnce(); expect(controller.snapshot.systemActionPending).toBe(true);
    fail(new Error("private host command output")); await pending;
    expect(controller.snapshot).toMatchObject({ status: "live", controlling: true, media: previousMedia,
      systemActionPending: false, systemActionFailure: "workspaceRight" });
    await vi.advanceTimersByTimeAsync(8_000);
    expect(value.systemAction).toHaveBeenCalledOnce(); expect(value.start).toHaveBeenCalledOnce(); expect(value.stop).not.toHaveBeenCalled();
    await controller.retrySystemAction();
    expect(value.systemAction).toHaveBeenCalledTimes(2); expect(value.systemAction.mock.calls[1]?.[3]).toBe("workspaceRight");
    expect(controller.snapshot.systemActionFailure).toBeUndefined(); await controller.close();
  });

  it.each(["control", "interactive", "route", "foreground", "owner", "viewer"] as const)("retires an in-flight action at the %s boundary", async (boundary) => {
    vi.useFakeTimers();
    const value = systemFixture(), controller = new MobileRemoteDesktopController(value.transport);
    let finish!: (action: "systemMenu") => void;
    value.systemAction.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await controller.open(); await flushAsync(); controller.viewerMessage({ type: "ready" });
    const pending = controller.performSystemAction("systemMenu"); await flushAsync();
    const signal = value.systemAction.mock.calls[0]?.[4];
    if (boundary === "control") await controller.setControl(false);
    if (boundary === "interactive") controller.setInteractive(false);
    if (boundary === "route") controller.setRouteFocused(false);
    if (boundary === "foreground") controller.setForeground(false);
    if (boundary === "owner") controller.authorityChanged();
    if (boundary === "viewer") controller.viewerProcessLost();
    expect(signal?.aborted).toBe(true);
    finish("systemMenu"); await pending;
    expect(controller.snapshot.systemActionPending).toBe(false); expect(controller.snapshot.systemActionFailure).toBeUndefined();
    await controller.retrySystemAction(); expect(value.systemAction).toHaveBeenCalledOnce(); await controller.close();
  });

  it("rejects a mismatched action receipt without replay and expires retry on control generation change", async () => {
    vi.useFakeTimers();
    const value = systemFixture(), controller = new MobileRemoteDesktopController(value.transport);
    value.systemAction.mockResolvedValueOnce("workspaceLeft");
    await controller.open(); await flushAsync(); await controller.performSystemAction("systemMenu");
    expect(controller.snapshot.systemActionFailure).toBe("systemMenu");
    value.heartbeat.mockResolvedValueOnce(create(RemoteDesktopControlStateSchema, { controlling: true, controlGeneration: 2n }));
    await vi.advanceTimersByTimeAsync(3_000); await controller.retrySystemAction();
    expect(value.systemAction).toHaveBeenCalledOnce(); expect(controller.snapshot.systemActionFailure).toBeUndefined(); await controller.close();
  });
});

describe("Mobile remote desktop input tools", () => {
  async function tools(platform = "darwin") {
    const value = fixture(false, true, false, true), commands: Record<string, unknown>[] = [];
    value.host.platform = platform; value.capabilities.platform = platform;
    if (platform === "win32") { value.capabilities.displayModes = false; value.capabilities.lockOnExit = false; }
    value.heartbeat.mockImplementation(async () => create(RemoteDesktopControlStateSchema, { controlling: true, controlGeneration: 1n }));
    const controller = new MobileRemoteDesktopController(value.transport, undefined, clipboardFixture(false).clipboard);
    controller.setViewerSink(command => commands.push(command));
    await controller.open(); await flushAsync(); controller.viewerMessage({ type: "ready" });
    controller.showKeyboard(); controller.selectKeyboardMode("computer"); commands.length = 0;
    return { ...value, controller, commands, events: () => commands.filter(command => command.type === "events").flatMap(command => command.events as object[]) };
  }
  it("deduplicates shared modifiers across overlapping presses and releases the last owner in reverse order", async () => {
    vi.useFakeTimers(); const value = await tools();
    value.controller.toggleKeyboardModifier("ControlLeft"); value.controller.toggleKeyboardModifier("ShiftLeft");
    const first = value.controller.pressKeyboardKey("KeyA"), second = value.controller.pressKeyboardKey("KeyB");
    expect(value.controller.pressKeyboardKey("KeyA")).toBeUndefined();
    value.controller.releaseKeyboardKey({ ...first! }); // An ID does not grant ownership.
    value.controller.releaseKeyboardKey(first); value.controller.releaseKeyboardKey(second);
    expect(value.events()).toEqual([
      { kind: "key", code: "ControlLeft", down: true }, { kind: "key", code: "ShiftLeft", down: true },
      { kind: "key", code: "KeyA", down: true }, { kind: "key", code: "KeyB", down: true },
      { kind: "key", code: "KeyA", down: false }, { kind: "key", code: "KeyB", down: false },
      { kind: "key", code: "ShiftLeft", down: false }, { kind: "key", code: "ControlLeft", down: false }
    ]);
    expect(value.controller.snapshot.keyboardModifiers).toEqual(["ControlLeft", "ShiftLeft"]); await value.controller.close();
  });
  it("holds physical modifiers independently and admits all 78 visible key codes through the existing input parser", async () => {
    vi.useFakeTimers(); const value = await tools(); value.controller.toggleKeyboardCombo(); value.commands.length = 0;
    const modifier = value.controller.pressKeyboardKey("ControlLeft"), key = value.controller.pressKeyboardKey("KeyA");
    value.controller.releaseKeyboardKey(key); expect(value.controller.snapshot.keyboardModifiers).toEqual(["ControlLeft"]);
    value.controller.releaseKeyboardKey(modifier); expect(value.controller.snapshot.keyboardModifiers).toEqual([]);
    const codes = new Set<MobileRemoteDesktopKeyCode>([...Object.values(mobileRemoteDesktopKeyPages).flat(2).filter(slot => slot !== null).map(slot => slot.code),
      ...mobileRemoteDesktopModifiers.map(modifier => modifier.code)]);
    expect(codes.size).toBe(78);
    for (const code of codes) {
      const grant = value.controller.pressKeyboardKey(code); expect(grant).toBeDefined(); value.controller.releaseKeyboardKey(grant);
      const pair = value.events().slice(-2);
      expect(mobileRemoteDesktopTesting.parseInputEvents(pair)?.map(event => event.event)).toEqual([
        { case: "key", value: expect.objectContaining({ code, down: true }) }, { case: "key", value: expect.objectContaining({ code, down: false }) }
      ]);
    }
    expect(value.controller.pressKeyboardKey("F13" as MobileRemoteDesktopKeyCode)).toBeUndefined(); await value.controller.close();
  });
  it.each(["page", "keyboard-mode", "combo", "pointer-mode", "release", "close", "copy", "paste"] as const)("releases and clears held input on %s", async reset => {
    vi.useFakeTimers(); const value = await tools(); value.controller.toggleKeyboardModifier("ControlLeft");
    const grant = value.controller.pressKeyboardKey("KeyC"); value.commands.length = 0;
    if (reset === "page") value.controller.selectKeyboardPage("function");
    if (reset === "keyboard-mode") value.controller.selectKeyboardMode("inputMethod");
    if (reset === "combo") value.controller.toggleKeyboardCombo();
    if (reset === "pointer-mode") value.controller.setInputMode("trackpad");
    if (reset === "release") value.controller.releaseInput();
    if (reset === "close") value.controller.closeKeyboard();
    if (reset === "copy") await value.controller.copyToPhone();
    if (reset === "paste") await value.controller.pasteFromPhone();
    expect(value.commands.some(command => command.type === "releaseInput" || command.type === "mode")).toBe(true);
    expect(value.controller.snapshot.keyboardModifiers).toEqual([]);
    value.controller.releaseKeyboardKey(grant); expect(value.events()).toEqual([]); await value.controller.close();
  });
  it.each(["control", "generation", "route", "interactive", "foreground", "online", "owner", "viewer", "display"] as const)("retires the captured press grant at the %s boundary", async boundary => {
    vi.useFakeTimers(); const value = await tools(), grant = value.controller.pressKeyboardKey("KeyA");
    if (boundary === "control") await value.controller.setControl(false);
    if (boundary === "generation") {
      value.heartbeat.mockResolvedValueOnce(create(RemoteDesktopControlStateSchema, { controlling: true, controlGeneration: 2n }));
      await vi.advanceTimersByTimeAsync(3_000);
    }
    if (boundary === "route") value.controller.setRouteFocused(false);
    if (boundary === "interactive") value.controller.setInteractive(false);
    if (boundary === "foreground") value.controller.setForeground(false);
    if (boundary === "online") value.controller.setOnline(false);
    if (boundary === "owner") value.controller.authorityChanged();
    if (boundary === "viewer") value.controller.viewerProcessLost();
    if (boundary === "display") await value.controller.setDisplayMode("20");
    expect(value.controller.snapshot.keyboardOpen).toBe(false); expect(value.controller.snapshot.keyboardModifiers).toEqual([]);
    const count = value.events().length; value.controller.releaseKeyboardKey(grant); expect(value.events()).toHaveLength(count);
    await value.controller.close();
  });
  it.each(["darwin", "win32", "linux"])("uses only resolved %s shortcut metadata and requires current control", async platform => {
    vi.useFakeTimers(); const value = await tools(platform); value.controller.closeKeyboard(); value.commands.length = 0;
    value.controller.performKeyboardShortcut("allWindows"); value.controller.performKeyboardShortcut("showDesktop");
    const codes = value.events().filter(event => (event as { down: boolean }).down).map(event => (event as { code: string }).code);
    expect(codes).toEqual(platform === "darwin" ? ["ControlLeft", "ArrowUp", "F11"] : platform === "win32" ? ["MetaLeft", "Tab", "MetaLeft", "KeyD"] : []);
    await value.controller.setControl(false); const count = value.events().length;
    value.controller.performKeyboardShortcut("allWindows"); expect(value.events()).toHaveLength(count); await value.controller.close();
  });
});

async function syncFixture(enabled = true) {
  const value = fixture(false, true, false, true);
  value.heartbeat.mockImplementation(async () => create(RemoteDesktopControlStateSchema, { controlling: true, controlGeneration: 1n }));
  const epoch = ++syncLocalEpoch;
  let localCounter = 1;
  let remoteCounter = 1;
  let localItem = { text: "phone initial" };
  let remoteItem = { text: "desktop initial" };
  let staged = "";
  const id = "11111111-1111-4111-8111-111111111111";
  const version = vi.fn<MobileRemoteClipboardSystem["version"]>(async check => { check(); return `${epoch}:${localCounter}`; });
  const readPortable = vi.fn<MobileRemoteClipboardSystem["readPortable"]>(async check => { check(); return localItem; });
  const writeExpected = vi.fn<MobileRemoteClipboardSystem["writeExpected"]>(async (item, expected, check) => {
    check();
    if (expected !== `${epoch}:${localCounter}`) throw new MobileRemoteClipboardError("changed");
    localItem = { text: item.text! };
    return `${epoch}:${++localCounter}`;
  });
  const clipboard: MobileRemoteClipboardSystem = { richAvailable: true, syncAvailable: true, version, readPortable, writeExpected,
    writePortable: vi.fn(async (_item, check) => { check(); }), readLegacyText: vi.fn(async () => ""), writeLegacyText: vi.fn(async () => undefined) };
  value.clipboardVersion.mockImplementation(async () => create(RemoteDesktopClipboardVersionResultSchema, { version: String(remoteCounter) }));
  value.clipboardContent.mockImplementation(async (_host, request) => {
    const action = request.action;
    if (action.case === "copy") {
      staged = JSON.stringify(remoteItem);
      return create(RemoteDesktopClipboardContentResultSchema, { length: staged.length,
        ...(request.inline ? { data: staged } : { transferId: id }) });
    }
    if (action.case === "read") return create(RemoteDesktopClipboardContentResultSchema, { data: staged.slice(action.value.offset) });
    if (action.case === "begin") { staged = ""; return create(RemoteDesktopClipboardContentResultSchema, { transferId: id }); }
    if (action.case === "write") { staged += action.value.data; return create(RemoteDesktopClipboardContentResultSchema, {}); }
    if (action.case === "commit" || action.case === "paste") {
      remoteItem = JSON.parse(action.case === "paste" ? action.value.data : staged) as typeof remoteItem;
      return create(RemoteDesktopClipboardContentResultSchema, { version: String(++remoteCounter) });
    }
    return create(RemoteDesktopClipboardContentResultSchema, {});
  });
  const disk = new Map<string, string>();
  const storage = { getItem: async (key: string) => disk.get(key) ?? null,
    setItem: vi.fn(async (key: string, raw: string) => { disk.set(key, raw); }) };
  const preferences = createMobileRemoteDesktopClipboardSyncPreferenceStore(storage);
  const identity = { ...value.transport.preferenceOwner, targetDeviceId: value.route.targetDeviceId };
  if (enabled) await preferences.save(identity, true);
  const controller = new MobileRemoteDesktopController(value.transport, undefined, clipboard, undefined, undefined, undefined, preferences);
  await controller.open();
  await vi.advanceTimersByTimeAsync(0);
  return { ...value, controller, clipboard, version, readPortable, writeExpected, disk, storage, preferences, identity,
    local: (text: string) => { localItem = { text }; localCounter += 1; },
    remote: (text: string) => { remoteItem = { text }; remoteCounter += 1; },
    localItem: () => localItem, remoteItem: () => remoteItem };
}

describe("Mobile clipboard sync lifecycle and effect authority", () => {
  it("saves sync intent in view only and allows a saved switch to turn off without host or native support", async () => {
    vi.useFakeTimers();
    const h = await syncFixture(false);
    await h.controller.setControl(false);
    h.setClipboardSync.mockClear();
    await h.controller.setClipboardSync(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(await h.preferences.load(h.identity)).toBe(true);
    expect(h.controller.snapshot.clipboardSync).toBe(true);
    expect(h.controller.snapshot.clipboardSyncActive).toBe(false);
    expect(h.setClipboardSync).not.toHaveBeenCalled();
    expect(h.version).not.toHaveBeenCalled();
    h.capabilities.clipboardSync = false;
    await h.controller.close();
    const second = new MobileRemoteDesktopController(h.transport, undefined, undefined, undefined, undefined, undefined, h.preferences);
    await second.open();
    await vi.advanceTimersByTimeAsync(0);
    expect(second.snapshot.clipboardSync).toBe(true);
    await second.setClipboardSync(false);
    expect(second.snapshot.clipboardSync).toBe(false);
    expect(await h.preferences.load(h.identity)).toBe(false);
    expect(h.setClipboardSync).not.toHaveBeenCalled();
    await second.setClipboardSync(true);
    expect(second.snapshot.clipboardSync).toBe(false);
    await second.close();
  });

  it("persists default-off intent before native reads and establishes a no-write baseline with exact generated scope", async () => {
    vi.useFakeTimers();
    const h = await syncFixture(false);
    expect(h.controller.snapshot.clipboardSync).toBe(false);
    expect(h.version).not.toHaveBeenCalled();
    let finish!: () => void;
    h.storage.setItem.mockImplementationOnce(async (key, raw) => {
      await new Promise<void>(resolve => { finish = resolve; }); h.disk.set(key, raw);
    });
    const saving = h.controller.setClipboardSync(true);
    await flushAsync();
    expect(h.controller.snapshot.clipboardSyncSaving).toBe(true);
    expect(h.controller.snapshot.clipboardSync).toBe(false);
    expect(h.setClipboardSync).not.toHaveBeenCalled();
    finish(); await saving; await vi.advanceTimersByTimeAsync(0);
    expect(await createMobileRemoteDesktopClipboardSyncPreferenceStore(h.storage).load(h.identity)).toBe(true);
    expect(h.controller.snapshot.clipboardSyncActive).toBe(true);
    expect(h.writeExpected).not.toHaveBeenCalled();
    expect(h.clipboardContent.mock.calls.some(([, request]) => request.action.case === "paste" || request.action.case === "commit")).toBe(false);
    expect(h.clipboardVersion.mock.calls[0]![1]).toMatchObject({ leaseId: "lease-1", controlGeneration: 1n, syncGeneration: 1n });
    expect(h.clipboardContent.mock.calls[0]![1]).toMatchObject({ sync: true, version: "1", inline: true, syncGeneration: 1n });
    expect(h.input).not.toHaveBeenCalled();
    await h.controller.close();
  });

  it("syncs both directions, does not echo and retains a conflict until a new copy", async () => {
    vi.useFakeTimers(); const h = await syncFixture();
    h.local("phone new"); await vi.advanceTimersByTimeAsync(1_500);
    expect(h.remoteItem()).toEqual({ text: "phone new" });
    expect(h.clipboardContent.mock.calls.filter(([, r]) => r.action.case === "paste")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(h.writeExpected).not.toHaveBeenCalled();
    h.remote("desktop new"); await vi.advanceTimersByTimeAsync(1_500);
    expect(h.localItem()).toEqual({ text: "desktop new" });
    expect(h.writeExpected).toHaveBeenCalledTimes(1);
    h.local("local conflict"); h.remote("remote conflict"); await vi.advanceTimersByTimeAsync(1_500);
    expect(h.controller.snapshot.clipboardSyncNotice).toBe("conflict");
    expect(h.localItem()).toEqual({ text: "local conflict" }); expect(h.remoteItem()).toEqual({ text: "remote conflict" });
    h.local("chosen copy"); await vi.advanceTimersByTimeAsync(1_500);
    expect(h.remoteItem()).toEqual({ text: "chosen copy" });
    expect(h.controller.snapshot.clipboardSyncNotice).toBeUndefined();
    expect(h.input).not.toHaveBeenCalled();
    await h.controller.close();
  });

  it("pauses route/control/PiP interaction and serializes a stale enable before replacement without adopting its token", async () => {
    vi.useFakeTimers(); const h = await syncFixture(false);
    let finish!: (result: Awaited<ReturnType<MobileRemoteDesktopTransport["setClipboardSync"]>>) => void;
    h.setClipboardSync.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await h.controller.setClipboardSync(true); await flushAsync();
    h.controller.setRouteFocused(false); h.controller.setInteractive(false);
    h.controller.setRouteFocused(true); h.controller.setInteractive(true);
    finish(create(RemoteDesktopClipboardSyncResultSchema, { enabled: true, syncGeneration: 99n }));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.setClipboardSync.mock.calls.map(([, r]) => r.enabled)).toEqual([true, false, true]);
    expect(h.clipboardVersion.mock.calls.every(([, r]) => r.syncGeneration === 1n)).toBe(true);
    await h.controller.setControl(false); await vi.advanceTimersByTimeAsync(0);
    const reads = h.clipboardVersion.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1_500);
    expect(h.clipboardVersion).toHaveBeenCalledTimes(reads);
    expect(h.controller.snapshot.clipboardSync).toBe(true);
    expect(h.controller.snapshot.clipboardSyncActive).toBe(false);
    await h.controller.close();
  });

  it("preserves copy history across route pause and retires a changed heartbeat control generation", async () => {
    vi.useFakeTimers(); const h = await syncFixture();
    let syncGeneration = 1n;
    h.setClipboardSync.mockImplementation(async (_host, request) =>
      create(RemoteDesktopClipboardSyncResultSchema, { enabled: request.enabled, syncGeneration: ++syncGeneration }));
    h.controller.setRouteFocused(false); h.controller.setInteractive(false);
    h.local("copy while paused"); await vi.advanceTimersByTimeAsync(500);
    h.controller.setRouteFocused(true); h.controller.setInteractive(true); await vi.advanceTimersByTimeAsync(0);
    expect(h.remoteItem()).toEqual({ text: "copy while paused" });
    const previous = h.clipboardVersion.mock.calls.length;
    h.heartbeat.mockImplementationOnce(async () => create(RemoteDesktopControlStateSchema, { controlling: true, controlGeneration: 2n }));
    await vi.advanceTimersByTimeAsync(2_500);
    expect(h.setClipboardSync.mock.calls.some(([, request]) => request.enabled && request.controlGeneration === 2n)).toBe(true);
    expect(h.clipboardVersion.mock.calls.slice(previous).some(([, request]) => request.controlGeneration === 2n)).toBe(true);
    const latest = h.clipboardVersion.mock.calls.at(-1)![1];
    expect(latest.controlGeneration).toBe(2n);
    expect(latest.syncGeneration).toBe(syncGeneration);
    await h.controller.close();
  });

  it("waits for explicit permission retry but automatically recovers temporary native window focus loss", async () => {
    vi.useFakeTimers(); const h = await syncFixture(false);
    h.version.mockRejectedValueOnce(new MobileRemoteClipboardError("permission"));
    await h.controller.setClipboardSync(true); await vi.advanceTimersByTimeAsync(0);
    expect(h.controller.snapshot.clipboardSyncNotice).toBe("permission");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.version).toHaveBeenCalledTimes(1);
    expect(await h.preferences.load(h.identity)).toBe(true);
    await h.controller.retryClipboardSync(); await vi.advanceTimersByTimeAsync(0);
    expect(h.controller.snapshot.clipboardSyncActive).toBe(true);
    h.version.mockRejectedValueOnce(new MobileRemoteClipboardError("temporary-focus"));
    await vi.advanceTimersByTimeAsync(1_500);
    expect(h.controller.snapshot.clipboardSyncNotice).toBe("failed");
    await vi.advanceTimersByTimeAsync(1_500);
    expect(h.controller.snapshot.clipboardSyncActive).toBe(true);
    expect(h.controller.snapshot.clipboardSyncNotice).toBeUndefined();
    await h.controller.close();
  });

  it("requires explicit sync Retry for a typed Linux outcome-unknown write without replaying its payload", async () => {
    vi.useFakeTimers(); const h = await syncFixture();
    h.local("phone change with an unconfirmed remote effect");
    h.clipboardContent.mockImplementationOnce(async () => {
      throw new ConnectError("Unconfirmed clipboard write", Code.Aborted, undefined, [{ desc: RemoteDesktopFailureSchema,
        value: create(RemoteDesktopFailureSchema, { reason: RemoteDesktopFailureReason.CLIPBOARD_UNAVAILABLE, retryable: false }) }]);
    });
    await vi.advanceTimersByTimeAsync(1500);
    expect(h.controller.snapshot).toMatchObject({ clipboardSyncActive: false, clipboardSyncNotice: "unknown" });
    const calls = h.clipboardContent.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000); expect(h.clipboardContent).toHaveBeenCalledTimes(calls);
    await h.controller.retryClipboardSync(); await vi.advanceTimersByTimeAsync(3000);
    expect(h.controller.snapshot.clipboardSyncActive).toBe(true);
    expect(h.clipboardContent.mock.calls.filter(([, request]) => request.action.case === "paste")).toHaveLength(1);
    await h.controller.close();
  });

  it("keeps an unknown native write in the shared effect slot and reconciles without replay", async () => {
    vi.useFakeTimers(); const h = await syncFixture();
    let finish!: (version: string) => void;
    h.writeExpected.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    h.remote("remote pending"); await vi.advanceTimersByTimeAsync(1_500);
    expect(h.writeExpected).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(MOBILE_REMOTE_CLIPBOARD_TRANSFER_MS);
    expect(h.controller.snapshot.clipboardSyncNotice).toBe("unknown");
    await h.controller.copyToPhone();
    expect(h.controller.snapshot.clipboardNotice).toBe("busy");
    const requests = h.clipboardContent.mock.calls.length;
    await h.controller.retryClipboardSync(); await vi.advanceTimersByTimeAsync(30_000);
    expect(h.clipboardContent).toHaveBeenCalledTimes(requests);
    expect(h.writeExpected).toHaveBeenCalledTimes(1);
    finish("late-version"); await vi.advanceTimersByTimeAsync(1_500);
    expect(h.writeExpected).toHaveBeenCalledTimes(1);
    await h.controller.close();
  });
});

function clipboardFixture(richAvailable = true) {
  const readPortable = vi.fn<MobileRemoteClipboardSystem["readPortable"]>(async (check) => {
    check();
    return { text: "phone text", html: "<b>phone text</b>" };
  });
  const writePortable = vi.fn<MobileRemoteClipboardSystem["writePortable"]>(async (_item, check) => {
    check();
  });
  const readLegacyText = vi.fn<MobileRemoteClipboardSystem["readLegacyText"]>(async (check) => {
    check();
    return "phone text";
  });
  const writeLegacyText = vi.fn<MobileRemoteClipboardSystem["writeLegacyText"]>(async (_text, check) => {
    check();
  });
  const clipboard: MobileRemoteClipboardSystem = {
    richAvailable, syncAvailable: false, version: vi.fn(async () => "1"), writeExpected: vi.fn(async () => "2"),
    readPortable, writePortable, readLegacyText, writeLegacyText
  };
  return { clipboard, readPortable, writePortable, readLegacyText, writeLegacyText };
}

function failure(reason: RemoteDesktopFailureReason, retryable = false): ConnectError {
  return new ConnectError("Remote Desktop request failed.", Code.FailedPrecondition, undefined, [{
    desc: RemoteDesktopFailureSchema,
    value: { reason, retryable }
  }]);
}

async function flushAsync(): Promise<void> {
  for (let turn = 0; turn < 12; turn += 1) await Promise.resolve();
}

describe("Mobile online display selection", () => {
  async function liveFixture(nativeVideo = false) {
    const value = fixture(true, true, true);
    const playback = vi.fn(async (_enabled: boolean) => undefined);
    const sendInput = vi.fn<(batch: MobileRemoteDesktopNativeInputBatch) => Promise<boolean>>(async () => true);
    const controller = new MobileRemoteDesktopController(value.transport, undefined, undefined,
      nativeVideo ? { nativeVideo: true, nativePictureInPicture: true, requiresPlaybackSession: true, playback, sendInput } : undefined);
    const commands: Record<string, unknown>[] = [];
    controller.setViewerSink(command => commands.push({ ...command }));
    await controller.open(); controller.viewerMessage({ type: "ready" });
    const epoch = commands.findLast(command => command.type === "init")!.epoch as string;
    const attemptId = "123e4567-e89b-42d3-a456-426614174000";
    if (nativeVideo) {
      controller.nativeMessage(JSON.stringify({ type: "iceConfig", epoch, attemptId }));
      controller.nativeMessage(JSON.stringify({ type: "videoFrameReady", epoch, attemptId }));
      controller.nativeMessage(JSON.stringify({ type: "streaming", epoch, attemptId }));
    } else {
      controller.viewerMessage({ type: "iceConfig", epoch, attemptId });
      controller.viewerMessage({ type: "streaming", epoch, attemptId });
    }
    await flushAsync();
    const display = create(RemoteDesktopDisplaySchema, { displayId: "display-2", name: "External", width: 2560, height: 1440 });
    value.capabilities.displays.push(display);
    value.start.mockResolvedValue(create(RemoteDesktopLeaseSchema, { ...value.lease, leaseId: "lease-2", display, controlling: false, controlGeneration: 2n }));
    return { ...value, controller, commands, epoch, attemptId, display, playback, sendInput };
  }

  it("permits the initial preselected monitor, refreshes every connection and ignores same or unknown live IDs", async () => {
    const value = fixture();
    value.capabilities.displays.push(create(RemoteDesktopDisplaySchema, { ...value.lease.display!, displayId: "display-2" }));
    const controller = new MobileRemoteDesktopController(value.transport);
    await controller.open(); expect(controller.snapshot.status).toBe("select-display"); expect(value.start).not.toHaveBeenCalled();
    await controller.selectDisplay("display-1");
    expect(value.transport.capabilities).toHaveBeenCalledTimes(2);
    expect(value.start).toHaveBeenCalledOnce();
    await controller.selectDisplay("display-1"); await controller.selectDisplay("missing");
    expect(value.start).toHaveBeenCalledOnce(); expect(value.stop).not.toHaveBeenCalled();
    await controller.close();
  });

  it.each([false, true])("retires renderer, media and input before the captured stop settles with native video %s", async nativeVideo => {
    vi.useFakeTimers(); const value = await liveFixture(nativeVideo);
    let stopped!: () => void;
    value.stop.mockImplementationOnce(async () => new Promise<void>(resolve => { stopped = resolve; }));
    let inputSettled!: (accepted: boolean) => void;
    let httpInputSettled!: () => void;
    if (nativeVideo) value.sendInput.mockImplementationOnce(async () => new Promise<boolean>(resolve => { inputSettled = resolve; }));
    else value.input.mockImplementationOnce(async () => new Promise<void>(resolve => { httpInputSettled = resolve; }));
    value.controller.viewerMessage({ type: "input", epoch: value.epoch, sequence: 1, events: [{ kind: "move", x: .3, y: .2 }] });
    await flushAsync();
    const caps = vi.mocked(value.transport.capabilities).mock.calls.length;
    const switching = value.controller.selectDisplay("display-2");
    await value.controller.selectDisplay("display-1"); await value.controller.retry();
    expect(value.controller.snapshot).toMatchObject({ status: "connecting", selectedDisplayId: "display-2",
      controlling: false, wantedControl: false, media: "none", hasFrame: false, displaySwitchBusy: true });
    expect(value.stop).toHaveBeenCalledOnce();
    expect(value.stop).toHaveBeenCalledWith(value.host, "lease-1", { lockScreen: false, controlGeneration: 0n }, expect.anything());
    expect(value.commands.some(command => command.type === "stop" && (!nativeVideo || command.epoch === value.epoch))).toBe(true);
    if (nativeVideo) expect(value.commands.findLast(command => command.type === "inputAuthority")).toMatchObject({ epoch: value.epoch, grant: null });
    await vi.advanceTimersByTimeAsync(6_000);
    expect(value.heartbeat).not.toHaveBeenCalled(); expect(value.start).toHaveBeenCalledOnce();
    expect(value.transport.capabilities).toHaveBeenCalledTimes(caps);
    stopped(); await switching;
    expect(value.transport.capabilities).toHaveBeenCalledTimes(caps + 1);
    expect(value.stop.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(value.transport.capabilities).mock.invocationCallOrder.at(-1)!);
    const nextEpoch = value.commands.findLast(command => command.type === "init")!.epoch;
    expect(nextEpoch).not.toBe(value.epoch);
    if (nativeVideo) inputSettled(false); else httpInputSettled();
    const count = value.commands.length;
    value.controller.viewerMessage({ type: "input", epoch: value.epoch, sequence: 2, events: [{ kind: "move", x: .1, y: .2 }] });
    value.controller.viewerMessage({ type: "streaming", epoch: value.epoch, attemptId: value.attemptId });
    value.controller.nativeMessage(JSON.stringify({ type: "videoFrameReady", epoch: value.epoch, attemptId: value.attemptId }));
    await flushAsync(); expect(value.commands).toHaveLength(count);
    expect(value.commands.some(command => command.type === "ack" && command.epoch === value.epoch)).toBe(false);
    if (nativeVideo) expect(value.input).not.toHaveBeenCalled();
    expect(value.controller.snapshot).toMatchObject({ status: "live", selectedDisplayId: "display-2", controlling: false,
      displaySwitchBusy: false, displaySwitchNotice: undefined });
    await value.controller.close();
  });

  it.each([RemoteDesktopFailureReason.STOPPED, RemoteDesktopFailureReason.LEASE_EXPIRED])(
    "accepts only a typed terminal lease result %s before NEW", async reason => {
      const value = await liveFixture(); value.stop.mockRejectedValueOnce(failure(reason));
      await value.controller.selectDisplay("display-2");
      expect(value.start).toHaveBeenLastCalledWith(value.host, "display-2", RemoteDesktopStartMode.NEW, expect.anything());
      expect(value.controller.snapshot).toMatchObject({ status: "live", displaySwitchNotice: undefined });
      await value.controller.close();
    });

  it.each([undefined, RemoteDesktopFailureReason.DISPLAY_RESTORE_UNAVAILABLE])(
    "retains an unconfirmed old lease after stop failure %s and retries only on explicit Retry", async reason => {
      vi.useFakeTimers(); const value = await liveFixture();
      value.stop.mockRejectedValueOnce(reason === undefined ? new Error("Stop receipt unavailable") : failure(reason));
      const caps = vi.mocked(value.transport.capabilities).mock.calls.length;
      await value.controller.selectDisplay("display-2");
      expect(value.controller.snapshot).toMatchObject({ status: "error", displaySwitchBusy: false, displaySwitchNotice: "stop-failed",
        controlling: false, wantedControl: false, media: "none", hasFrame: false });
      await value.controller.selectDisplay("display-1");
      await vi.advanceTimersByTimeAsync(20_000);
      expect(value.start).toHaveBeenCalledOnce(); expect(value.transport.capabilities).toHaveBeenCalledTimes(caps);
      value.stop.mockRejectedValueOnce(failure(RemoteDesktopFailureReason.STOPPED));
      await value.controller.retry();
      expect(value.stop).toHaveBeenCalledTimes(2);
      expect(value.stop.mock.calls.every(call => call[1] === "lease-1" && !call[2].lockScreen)).toBe(true);
      expect(value.start).toHaveBeenCalledTimes(2);
      expect(value.controller.snapshot).toMatchObject({ status: "live", selectedDisplayId: "display-2", displaySwitchNotice: undefined });
      await value.controller.close();
    });

  it("requires a fresh explicit display choice when the new capabilities no longer contain the selected display", async () => {
    vi.useFakeTimers(); const value = await liveFixture();
    vi.mocked(value.transport.capabilities).mockResolvedValueOnce({ ...value.capabilities, displays: [value.lease.display!] });
    await value.controller.selectDisplay("display-2");
    expect(value.controller.snapshot).toMatchObject({ status: "select-display", selectedDisplayId: undefined,
      displaySwitchNotice: "display-missing", displaySwitchBusy: false });
    expect(value.start).toHaveBeenCalledOnce();
    await value.controller.retry(); value.controller.setOnline(false); value.controller.setOnline(true);
    await vi.advanceTimersByTimeAsync(15_000); expect(value.start).toHaveBeenCalledOnce();
    value.start.mockResolvedValueOnce({ ...value.lease, leaseId: "lease-3" });
    await value.controller.selectDisplay("display-1");
    expect(value.controller.snapshot).toMatchObject({ status: "live", selectedDisplayId: "display-1", displaySwitchNotice: undefined });
    await value.controller.close();
  });

  it("closes an unknown display stop through the captured ordinary lease without obtaining saved lock authority", async () => {
    const value = fixture(true, true, false, true);
    const store = createMobileRemoteDesktopLockPreferenceStore({
      getItem: async () => JSON.stringify({ version: 1, enabled: true }), setItem: async () => undefined
    });
    const controller = new MobileRemoteDesktopController(value.transport, undefined, undefined, undefined, undefined, store);
    await controller.open(); await flushAsync();
    // Use the normal preference write so the saved intent belongs to this target.
    await controller.setLockOnExit(true);
    expect(controller.snapshot).toMatchObject({ lockOnExitLoaded: true, lockOnExit: true });
    value.capabilities.displays.push(create(RemoteDesktopDisplaySchema, { ...value.lease.display!, displayId: "display-2" }));
    value.stop.mockRejectedValueOnce(new Error("Stop receipt unavailable"));
    await controller.selectDisplay("display-2");
    value.stop.mockRejectedValueOnce(failure(RemoteDesktopFailureReason.STOPPED));
    expect(await controller.leave(true)).toBe("closed");
    expect(value.stop.mock.calls[1]).toEqual([value.host, "lease-1", { lockScreen: false, controlGeneration: 0n }, expect.anything()]);
    expect(controller.snapshot).toMatchObject({ exitStatus: "closed", exitLockRequested: false });
    await controller.close();
  });

  it("does not adopt a late stop receipt or resume automatically after going offline during selection", async () => {
    const value = await liveFixture(); let stopped!: () => void;
    value.stop.mockImplementationOnce(async () => new Promise<void>(resolve => { stopped = resolve; }));
    const switching = value.controller.selectDisplay("display-2");
    value.controller.setOnline(false); stopped(); await switching; value.controller.setOnline(true); await flushAsync();
    expect(value.start).toHaveBeenCalledOnce(); expect(value.controller.snapshot.displaySwitchBusy).toBe(false);
    value.stop.mockRejectedValueOnce(failure(RemoteDesktopFailureReason.LEASE_EXPIRED));
    await value.controller.retry(); expect(value.stop).toHaveBeenCalledTimes(2);
    expect(value.stop.mock.calls[1]?.[1]).toBe("lease-1"); expect(value.controller.snapshot.status).toBe("live");
    await value.controller.close();
  });

  it("keeps a replacement offer single flight when retired offer, ICE and frame responses arrive late", async () => {
    const value = await liveFixture();
    let oldOffer!: (result: Awaited<ReturnType<MobileRemoteDesktopTransport["offer"]>>) => void;
    let nextOffer!: (result: Awaited<ReturnType<MobileRemoteDesktopTransport["offer"]>>) => void;
    let oldIce!: (result: Awaited<ReturnType<MobileRemoteDesktopTransport["ice"]>>) => void;
    let oldFrame!: (result: Awaited<ReturnType<MobileRemoteDesktopTransport["frame"]>>) => void;
    value.offer.mockImplementationOnce(async () => new Promise(resolve => { oldOffer = resolve; }))
      .mockImplementationOnce(async () => new Promise(resolve => { nextOffer = resolve; }));
    vi.mocked(value.transport.ice).mockImplementationOnce(async () => new Promise(resolve => { oldIce = resolve; }));
    value.frame.mockImplementationOnce(async () => new Promise(resolve => { oldFrame = resolve; }));
    value.controller.viewerMessage({ type: "offer", epoch: value.epoch, attemptId: value.attemptId, sdp: "old-offer" });
    value.controller.viewerMessage({ type: "ice", epoch: value.epoch, attemptId: value.attemptId, candidates: [], after: 0, exchangeId: 1 });
    value.controller.viewerMessage({ type: "fallback", epoch: value.epoch, attemptId: value.attemptId });
    await flushAsync(); await value.controller.selectDisplay("display-2");
    const epoch = value.commands.findLast(command => command.type === "init")!.epoch as string;
    value.controller.viewerMessage({ type: "iceConfig", epoch, attemptId: "replacement" });
    value.controller.viewerMessage({ type: "offer", epoch, attemptId: "replacement", sdp: "next-offer" });
    await flushAsync();
    oldOffer({ $typeName: "joko.v1.RemoteDesktopOfferResult", attemptId: value.attemptId, answerSdp: "old-answer" });
    oldIce({ $typeName: "joko.v1.RemoteDesktopIceExchangeResult", attemptId: value.attemptId, candidates: [], next: 0, complete: true });
    oldFrame(create(RemoteDesktopFrameResultSchema, { frame: create(RemoteDesktopFrameSchema, { jpeg: Uint8Array.of(1) }) }));
    await flushAsync();
    expect(value.commands.some(command => ["answer", "ice", "frame"].includes(command.type as string) && command.epoch === value.epoch)).toBe(false);
    value.controller.viewerMessage({ type: "offer", epoch, attemptId: "replacement", sdp: "queued-offer" });
    await flushAsync(); expect(value.offer).toHaveBeenCalledTimes(2);
    nextOffer({ $typeName: "joko.v1.RemoteDesktopOfferResult", attemptId: "replacement", answerSdp: "next-answer" });
    await flushAsync(); expect(value.offer).toHaveBeenCalledTimes(3);
    expect(value.commands.filter(command => command.type === "answer").every(command => command.epoch === epoch)).toBe(true);
    await value.controller.close();
  });
});

function cursorPng(width = 32, height = 32): Uint8Array {
  return Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
    (width >>> 24) & 0xff, (width >>> 16) & 0xff, (width >>> 8) & 0xff, width & 0xff,
    (height >>> 24) & 0xff, (height >>> 16) & 0xff, (height >>> 8) & 0xff, height & 0xff,
    8, 6, 0, 0, 0, 0, 0, 0, 0
  ]);
}

describe("Mobile permission guidance", () => {
  async function permissionFixture() {
    const value = fixture();
    value.capabilities.permissions!.screenRecording = RemoteDesktopPermissionStatus.MISSING;
    value.capabilities.permissions!.accessibility = RemoteDesktopPermissionStatus.UNKNOWN;
    value.capabilities.canControl = false;
    const controller = new MobileRemoteDesktopController(value.transport);
    await controller.open(); return { ...value, controller };
  }
  const ready = () => create(RemoteDesktopPermissionsSchema, { screenRecording: RemoteDesktopPermissionStatus.GRANTED,
    accessibility: RemoteDesktopPermissionStatus.NOT_REQUIRED });

  it("projects each permission and polls immediately and every two seconds single flight without connecting or granting control", async () => {
    vi.useFakeTimers(); const value = await permissionFixture(); let finish!: (permissions: RemoteDesktopPermissions) => void;
    expect(value.controller.snapshot).toMatchObject({ status: "permission", permissions: {
      screenRecording: RemoteDesktopPermissionStatus.MISSING, accessibility: RemoteDesktopPermissionStatus.UNKNOWN } });
    vi.mocked(value.transport.permissions).mockImplementationOnce(async () => new Promise(resolve => { finish = resolve; }));
    value.controller.setPermissionGuideVisible(true);
    expect(value.controller.snapshot.permissionCheckStatus).toBe("checking"); expect(value.transport.permissions).toHaveBeenCalledOnce();
    await value.controller.refreshPermissions(); await vi.advanceTimersByTimeAsync(6_000);
    expect(value.transport.permissions).toHaveBeenCalledOnce(); finish(ready()); await flushAsync();
    expect(value.controller.snapshot).toMatchObject({ status: "permission", permissionCheckStatus: "ready", permissions: ready() });
    expect(value.controller.snapshot.capabilities?.canControl).toBe(false);
    expect(value.controller.snapshot.capabilities?.permissions?.screenRecording).toBe(RemoteDesktopPermissionStatus.MISSING);
    vi.mocked(value.transport.permissions).mockResolvedValueOnce(create(RemoteDesktopPermissionsSchema, {
      screenRecording: RemoteDesktopPermissionStatus.UNSPECIFIED, accessibility: 99 as RemoteDesktopPermissionStatus }));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(value.controller.snapshot.permissions).toMatchObject({ screenRecording: RemoteDesktopPermissionStatus.UNKNOWN,
      accessibility: RemoteDesktopPermissionStatus.UNKNOWN });
    expect(value.start).not.toHaveBeenCalled(); expect(value.control).not.toHaveBeenCalled();
    value.capabilities.permissions!.screenRecording = RemoteDesktopPermissionStatus.NOT_REQUIRED;
    await value.controller.retry();
    expect(value.start).toHaveBeenCalledOnce(); expect(value.start).toHaveBeenLastCalledWith(value.host, "display-1", RemoteDesktopStartMode.NEW, expect.anything());
    await value.controller.close();
  });

  it("keeps failed checks local and clears bounded feedback on the next read", async () => {
    vi.useFakeTimers(); const value = await permissionFixture();
    vi.mocked(value.transport.permissions).mockRejectedValueOnce(new Error("Private remote failure"));
    value.controller.setPermissionGuideVisible(true); await flushAsync();
    expect(value.controller.snapshot).toMatchObject({ status: "permission", permissionCheckStatus: "failed", permissionNotice: "check-failed" });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(value.controller.snapshot).toMatchObject({ status: "permission", permissionCheckStatus: "ready", permissionNotice: undefined });
    expect(value.start).not.toHaveBeenCalled(); expect(value.control).not.toHaveBeenCalled(); await value.controller.close();
  });

  it("offers fresh display selection after initial permission recovery when several monitors remain available", async () => {
    const value = await permissionFixture();
    value.capabilities.displays.push(create(RemoteDesktopDisplaySchema, { ...value.lease.display!, displayId: "display-2" }));
    value.capabilities.permissions!.screenRecording = RemoteDesktopPermissionStatus.GRANTED;
    await value.controller.retry();
    expect(value.controller.snapshot).toMatchObject({ status: "select-display", selectedDisplayId: "display-1" });
    expect(value.start).not.toHaveBeenCalled();
    await value.controller.selectDisplay("display-1");
    expect(value.start).toHaveBeenCalledOnce(); expect(value.controller.snapshot.status).toBe("live");
    await value.controller.close();
  });

  it("opens the host guide single flight and preserves its receipt through polls without reconnecting", async () => {
    vi.useFakeTimers(); const value = await permissionFixture(); let finish!: (permissions: RemoteDesktopPermissions) => void;
    value.controller.setPermissionGuideVisible(true); await flushAsync();
    vi.mocked(value.transport.showPermissionGuide).mockImplementationOnce(async () => new Promise(resolve => { finish = resolve; }));
    const guiding = value.controller.refreshPermissions(true); await value.controller.refreshPermissions(true);
    expect(value.controller.snapshot.permissionGuideStatus).toBe("pending"); expect(value.transport.showPermissionGuide).toHaveBeenCalledOnce();
    finish(ready()); await guiding; await vi.advanceTimersByTimeAsync(2_000);
    expect(value.controller.snapshot).toMatchObject({ status: "permission", permissionGuideStatus: "opened", permissionNotice: "guide-opened" });
    expect(value.start).not.toHaveBeenCalled(); expect(value.control).not.toHaveBeenCalled(); await value.controller.close();
  });

  it.each([false, true])("does not replay a failed guide action whose outcome is unknown %s", async unknown => {
    vi.useFakeTimers(); const value = await permissionFixture(); value.controller.setPermissionGuideVisible(true); await flushAsync();
    vi.mocked(value.transport.showPermissionGuide).mockRejectedValueOnce(unknown ? new Error("Receipt unavailable")
      : failure(RemoteDesktopFailureReason.SCREEN_PERMISSION_REQUIRED));
    await value.controller.refreshPermissions(true);
    expect(value.controller.snapshot).toMatchObject({ status: "permission", permissionGuideStatus: unknown ? "unknown" : "failed",
      permissionNotice: unknown ? "guide-unknown" : "guide-failed" });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(value.transport.showPermissionGuide).toHaveBeenCalledOnce(); expect(value.start).not.toHaveBeenCalled(); await value.controller.close();
  });

  it.each(["visible", "route", "interactive", "foreground", "online", "owner", "request", "exit", "host"] as const)(
    "retires pending checks and guide receipts at the %s boundary", async boundary => {
      vi.useFakeTimers(); const value = await permissionFixture();
      let checked!: (permissions: RemoteDesktopPermissions) => void, guided!: (permissions: RemoteDesktopPermissions) => void;
      let checkSignal: AbortSignal | undefined, guideSignal: AbortSignal | undefined;
      vi.mocked(value.transport.permissions).mockImplementationOnce(async (_host, signal) => {
        checkSignal = signal; return new Promise(resolve => { checked = resolve; });
      });
      vi.mocked(value.transport.showPermissionGuide).mockImplementationOnce(async (_host, signal) => {
        guideSignal = signal; return new Promise(resolve => { guided = resolve; });
      });
      value.controller.setPermissionGuideVisible(true); const guiding = value.controller.refreshPermissions(true);
      if (boundary === "visible") value.controller.setPermissionGuideVisible(false);
      if (boundary === "route") value.controller.setRouteFocused(false);
      if (boundary === "interactive") value.controller.setInteractive(false);
      if (boundary === "foreground") value.controller.setForeground(false);
      if (boundary === "online") value.controller.setOnline(false);
      if (boundary === "owner") { value.transport.isCurrent = () => false; value.controller.authorityChanged(); }
      if (boundary === "request") await value.controller.retry();
      if (boundary === "exit") await value.controller.leave();
      if (boundary === "host") await value.controller.selectHost(value.host);
      expect(checkSignal?.aborted).toBe(true); expect(guideSignal?.aborted).toBe(true);
      checked(ready()); guided(ready()); await guiding; await flushAsync();
      expect(value.controller.snapshot.permissions?.screenRecording).toBe(RemoteDesktopPermissionStatus.MISSING);
      expect(value.controller.snapshot.permissionGuideStatus).not.toBe("opened");
      const reads = vi.mocked(value.transport.permissions).mock.calls.length; await vi.advanceTimersByTimeAsync(2_000);
      expect(value.transport.showPermissionGuide).toHaveBeenCalledOnce(); expect(value.start).not.toHaveBeenCalled();
      if (!["request", "host"].includes(boundary)) expect(value.transport.permissions).toHaveBeenCalledTimes(reads);
      await value.controller.close();
    });

  it.each(["foreground", "online", "route"] as const)("restores only terminal permission reads after %s returns", async boundary => {
    vi.useFakeTimers(); const value = await permissionFixture(); value.controller.setPermissionGuideVisible(true); await flushAsync();
    if (boundary === "foreground") value.controller.setForeground(false);
    if (boundary === "online") value.controller.setOnline(false);
    if (boundary === "route") value.controller.setRouteFocused(false);
    const reads = vi.mocked(value.transport.permissions).mock.calls.length;
    await vi.advanceTimersByTimeAsync(6_000); expect(value.transport.permissions).toHaveBeenCalledTimes(reads);
    if (boundary === "foreground") value.controller.setForeground(true);
    if (boundary === "online") value.controller.setOnline(true);
    if (boundary === "route") value.controller.setRouteFocused(true);
    await flushAsync(); await vi.advanceTimersByTimeAsync(2_000);
    expect(value.controller.snapshot).toMatchObject({ status: "permission", permissionCheckStatus: "ready" });
    expect(vi.mocked(value.transport.permissions).mock.calls.length).toBeGreaterThan(reads);
    expect(value.start).not.toHaveBeenCalled(); expect(value.control).not.toHaveBeenCalled(); await value.controller.close();
  });

  it("does not replace newer guide rows with an older concurrent permission check", async () => {
    const value = await permissionFixture(); let checked!: (permissions: RemoteDesktopPermissions) => void;
    vi.mocked(value.transport.permissions).mockImplementationOnce(async () => new Promise(resolve => { checked = resolve; }));
    value.controller.setPermissionGuideVisible(true); vi.mocked(value.transport.showPermissionGuide).mockResolvedValueOnce(ready());
    await value.controller.refreshPermissions(true);
    expect(value.controller.snapshot).toMatchObject({ permissionCheckStatus: "checking", permissionGuideStatus: "opened", permissions: ready() });
    checked(value.capabilities.permissions!); await flushAsync();
    expect(value.controller.snapshot).toMatchObject({ permissionCheckStatus: "ready", permissionGuideStatus: "opened", permissions: ready() });
    expect(value.start).not.toHaveBeenCalled(); await value.controller.close();
  });

  it("keeps accepted video and view-only after accessibility rejection while guidance rows never grant control", async () => {
    vi.useFakeTimers(); const value = fixture(true, false);
    value.control.mockRejectedValueOnce(failure(RemoteDesktopFailureReason.ACCESSIBILITY_PERMISSION_REQUIRED));
    const controller = new MobileRemoteDesktopController(value.transport), commands: Record<string, unknown>[] = [];
    controller.setViewerSink(command => commands.push({ ...command })); await controller.open(); controller.viewerMessage({ type: "ready" });
    const epoch = commands.findLast(command => command.type === "init")!.epoch as string;
    controller.viewerMessage({ type: "iceConfig", epoch, attemptId: "visible" }); controller.viewerMessage({ type: "streaming", epoch, attemptId: "visible" });
    await controller.setControl(true);
    expect(controller.snapshot).toMatchObject({ status: "live", media: "webrtc", hasFrame: true, controlling: false,
      wantedControl: false, notice: "accessibility-permission" });
    vi.mocked(value.transport.permissions).mockResolvedValue(create(RemoteDesktopPermissionsSchema, {
      screenRecording: RemoteDesktopPermissionStatus.UNKNOWN, accessibility: RemoteDesktopPermissionStatus.GRANTED }));
    controller.setPermissionGuideVisible(true); await flushAsync(); await vi.advanceTimersByTimeAsync(2_000);
    expect(controller.snapshot).toMatchObject({ status: "live", media: "webrtc", hasFrame: true, controlling: false, wantedControl: false,
      permissions: { screenRecording: RemoteDesktopPermissionStatus.UNKNOWN, accessibility: RemoteDesktopPermissionStatus.GRANTED } });
    expect(value.start).toHaveBeenCalledOnce(); expect(value.control).toHaveBeenCalledOnce(); expect(value.stop).not.toHaveBeenCalled();
    expect(controller.snapshot.capabilities).toBe(value.capabilities); controller.setPermissionGuideVisible(false); await controller.close();
  });
});

describe("MobileRemoteDesktopController", () => {
  it.each(["darwin", "linux"])("authenticates %s once at its required capture boundary and refreshes control capability", async platform => {
    vi.useFakeTimers(); const value = fixture(true); value.capabilities.canControl = false; value.capabilities.nativeCredentials = true;
    value.host.platform = platform; value.capabilities.platform = platform;
    let unlocked = false;
    const native: MobileRemoteDesktopCredentialsNative = { available: true, configure: vi.fn(async () => "public-controller"),
      settings: vi.fn(async () => ({ autoUnlock: true, biometricVerification: false, biometricAvailable: true, biometricPreferred: false })),
      forget: vi.fn(async () => undefined), biometric: vi.fn(async () => undefined),
      begin: vi.fn(async () => ({ handle: "11111111-1111-4111-8111-111111111111", offer: "controller-offer", descriptor: "public-controller" })),
      accept: vi.fn(async () => "ready-request"), receive: vi.fn(async (_handle, ciphertext) => ciphertext === "ready"
        ? JSON.stringify({ kind: "ready", saved: true }) : JSON.stringify({ kind: "authenticated", accepted: true })),
      password: vi.fn(async () => "password-ciphertext"), authenticationStatus: vi.fn(async () => "receipt-ciphertext"),
      end: vi.fn(async () => null), close: vi.fn(async () => undefined) };
    value.transport.lockState = vi.fn(async () => RemoteDesktopLockState.LOCKED);
    value.transport.credentials = vi.fn(async (_host, request) => {
      const action = request.request;
      if (action.case === "prepare") return create(RemoteDesktopCredentialResultSchema, { result: { case: "prepared", value: { descriptor: "public-host" } } });
      if (action.case === "open") return create(RemoteDesktopCredentialResultSchema, { result: { case: "opened", value: { handle: "22222222-2222-4222-8222-222222222222", offer: "host-offer" } } });
      if (action.case !== "exchange") throw new Error("Unexpected request");
      if (action.value.ciphertext === "password-ciphertext") unlocked = true;
      return create(RemoteDesktopCredentialResultSchema, { result: { case: "exchanged", value: { ciphertext: action.value.ciphertext === "ready-request" ? "ready" : "authenticated" } } });
    });
    vi.mocked(value.transport.capabilities).mockImplementation(async () => ({ ...value.capabilities, canControl: unlocked }));
    value.start.mockImplementation(async () => ({ ...value.lease, leaseId: unlocked ? "fresh-unlocked-lease" : "locked-view-lease", controlGeneration: unlocked ? 2n : 1n }));
    value.control.mockImplementation(async (_host, _lease, enabled) => create(RemoteDesktopControlStateSchema, { controlling: enabled, controlGeneration: 3n }));
    const controller = new MobileRemoteDesktopController(value.transport, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      { native, locale: () => "en", theme: () => "dark" });
    const commands: Record<string, unknown>[] = []; controller.setViewerSink(command => commands.push(command as Record<string, unknown>));
    await controller.open(); await flushAsync(); controller.viewerMessage({ type: "ready" });
    let epoch = commands.filter(command => command.type === "init").at(-1)?.epoch;
    if (platform === "darwin") {
      expect(native.password).not.toHaveBeenCalled();
      controller.viewerMessage({ type: "iceConfig", epoch, attemptId: "locked-attempt" });
      controller.viewerMessage({ type: "streaming", epoch, attemptId: "locked-attempt" });
      await vi.waitFor(() => expect(value.start).toHaveBeenCalledTimes(2));
      expect(value.start).toHaveBeenCalledTimes(2);
      expect(value.stop).toHaveBeenCalledWith(value.host, "locked-view-lease", { lockScreen: false, controlGeneration: 0n }, expect.anything());
    } else {
      expect(native.password).toHaveBeenCalledOnce(); expect(value.start).toHaveBeenCalledOnce();
      expect(vi.mocked(native.password).mock.invocationCallOrder[0]).toBeLessThan(value.start.mock.invocationCallOrder[0]!);
      expect(value.stop).not.toHaveBeenCalled();
    }
    expect(value.transport.capabilities).toHaveBeenCalledTimes(3);
    expect(native.begin).toHaveBeenCalledWith("desktop-1", false, false, "public-host", platform);
    expect(controller.snapshot.capabilities?.canControl).toBe(true);
    epoch = commands.filter(command => command.type === "init").at(-1)?.epoch;
    controller.viewerMessage({ type: "iceConfig", epoch, attemptId: "unlocked-attempt" });
    controller.viewerMessage({ type: "streaming", epoch, attemptId: "unlocked-attempt" }); await flushAsync();
    expect(native.password).toHaveBeenCalledOnce(); await controller.setControl(true);
    expect(value.control).toHaveBeenCalledWith(value.host, "fresh-unlocked-lease", true, expect.anything());
    expect(controller.snapshot.controlling).toBe(true);
    await controller.close();
  });

  it("presaves privacy in view-only mode, adopts it after persistence, and can disable saved intent without capability", async () => {
    const value = fixture(true, false, false, true);
    let complete!: () => void;
    const disk = new Map<string, string>();
    const preferences = createMobileRemoteDesktopPrivacyPreferenceStore({ getItem: async key => disk.get(key) ?? null,
      setItem: async (key, raw) => { await new Promise<void>(resolve => { complete = resolve; }); disk.set(key, raw); } });
    const controller = new MobileRemoteDesktopController(value.transport, undefined, undefined, undefined, undefined, undefined, undefined, preferences);
    await controller.open(); await flushAsync();
    expect(controller.snapshot).toMatchObject({ privacyScreen: false, privacyScreenLoaded: true, controlling: false });
    const saving = controller.setPrivacyScreen(true); await flushAsync();
    expect(controller.snapshot.privacyScreen).toBe(false); expect(value.setPrivacyScreen).not.toHaveBeenCalled();
    complete(); await saving; expect(controller.snapshot.privacyScreen).toBe(true);
    await controller.setControl(true); await flushAsync();
    expect(controller.snapshot.privacyScreenActive).toBe(true);
    await controller.close();
    value.capabilities.privacyScreen = false;
    const reloaded = createMobileRemoteDesktopPrivacyPreferenceStore({ getItem: async key => disk.get(key) ?? null,
      setItem: async (key, raw) => { disk.set(key, raw); } });
    const second = new MobileRemoteDesktopController(value.transport, undefined, undefined, undefined, undefined, undefined, undefined, reloaded);
    await second.open(); await flushAsync(); expect(second.snapshot.privacyScreen).toBe(true);
    await second.setPrivacyScreen(false); expect(second.snapshot.privacyScreen).toBe(false);
    expect(await reloaded.load({ ...value.transport.preferenceOwner, targetDeviceId: "desktop-1" })).toBe(false);
    await second.close();
  });

  it("keeps privacy failures explicit without heartbeat replay and applies the latest saved exit dependency", async () => {
    vi.useFakeTimers();
    const value = fixture(true, true, false, true);
    value.heartbeat.mockResolvedValue(create(RemoteDesktopControlStateSchema, { controlling: true, controlGeneration: 1n }));
    value.setPrivacyScreen.mockRejectedValueOnce(failure(RemoteDesktopFailureReason.PRIVACY_FAILED));
    const privacy: MobileRemoteDesktopPrivacyPreferences = { load: async () => true, save: async () => undefined };
    const locks = { load: async () => false, save: async () => undefined };
    const controller = new MobileRemoteDesktopController(value.transport, undefined, undefined, undefined, undefined, locks, undefined, privacy);
    await controller.open(); await flushAsync();
    expect(controller.snapshot).toMatchObject({ privacyScreen: true, privacyScreenActive: false, privacyScreenNotice: "privacy-failed", status: "live" });
    await vi.advanceTimersByTimeAsync(9000); expect(value.setPrivacyScreen).toHaveBeenCalledTimes(1);
    await controller.setLockOnExit(true); await flushAsync();
    expect(value.setPrivacyScreen.mock.calls.at(-1)?.slice(1, 5)).toEqual(["lease-1", 1n, true, true]);
    expect(controller.snapshot.privacyScreenActive).toBe(true);
    const attempts = value.setPrivacyScreen.mock.calls.length;
    controller.setInteractive(false); await flushAsync();
    expect(controller.snapshot.privacyScreenActive).toBe(true); expect(value.setPrivacyScreen).toHaveBeenCalledTimes(attempts);
    await controller.close();
    expect(value.setPrivacyScreen.mock.calls.every(call => call[3])).toBe(true);
  });

  it("rejects a late privacy receipt after a new controlling generation and reapplies once for that generation", async () => {
    vi.useFakeTimers();
    const value = fixture(true, true, false, true);
    let receipt!: (result: ReturnType<typeof create<typeof RemoteDesktopPrivacyScreenResultSchema>>) => void;
    value.setPrivacyScreen.mockImplementationOnce(() => new Promise(resolve => { receipt = resolve; }));
    value.heartbeat.mockResolvedValue(create(RemoteDesktopControlStateSchema, { controlling: true, controlGeneration: 2n }));
    const controller = new MobileRemoteDesktopController(value.transport, undefined, undefined, undefined, undefined, undefined, undefined,
      { load: async () => true, save: async () => undefined });
    await controller.open(); await flushAsync(); await vi.advanceTimersByTimeAsync(3000);
    expect(controller.snapshot.privacyScreenActive).toBe(false);
    receipt(create(RemoteDesktopPrivacyScreenResultSchema, { enabled: true })); await vi.advanceTimersByTimeAsync(0);
    expect(value.setPrivacyScreen.mock.calls.at(-1)?.slice(1, 5)).toEqual(["lease-1", 2n, true, false]);
    expect(controller.snapshot.privacyScreenActive).toBe(true);
    const attempts = value.setPrivacyScreen.mock.calls.length;
    await vi.advanceTimersByTimeAsync(6000); expect(value.setPrivacyScreen).toHaveBeenCalledTimes(attempts);
    await controller.close();
  });

  it("recovers privacy load and save failures explicitly while preserving confirmed intent", async () => {
    const value = fixture(true, false, false, true);
    const load = vi.fn(async () => false).mockRejectedValueOnce(new Error("disk unavailable"));
    const save = vi.fn(async () => undefined).mockRejectedValueOnce(new Error("disk full"));
    const controller = new MobileRemoteDesktopController(value.transport, undefined, undefined, undefined, undefined, undefined, undefined, { load, save });
    await controller.open(); await flushAsync(); expect(controller.snapshot.privacyScreenNotice).toBe("load-failed");
    await controller.retryPrivacyScreenPreference(); await controller.setPrivacyScreen(true);
    expect(controller.snapshot).toMatchObject({ privacyScreen: false, privacyScreenNotice: "save-failed" });
    await controller.retryPrivacyScreenPreference(); expect(controller.snapshot.privacyScreen).toBe(true);
    expect(value.setPrivacyScreen).not.toHaveBeenCalled(); await controller.close();
  });

  it("retires privacy actual state through the confirmed PiP control transition without sending an independent off", async () => {
    vi.useFakeTimers();
    const value = fixture(true, true, true, true);
    value.presentation.mockResolvedValue(create(RemoteDesktopControlStateSchema, { controlling: false, controlGeneration: 2n }));
    const controller = new MobileRemoteDesktopController(value.transport, undefined, undefined,
      { nativePictureInPicture: true, requiresPlaybackSession: true, playback: async () => undefined },
      undefined, undefined, undefined, { load: async () => true, save: async () => undefined });
    const commands: Record<string, unknown>[] = [];
    controller.setViewerSink(command => commands.push(command as Record<string, unknown>));
    await controller.open(); await flushAsync(); controller.viewerMessage({ type: "ready" });
    const epoch = commands.find(command => command.type === "init")?.epoch;
    controller.viewerMessage({ type: "iceConfig", epoch, attemptId: "privacy-pip" });
    controller.viewerMessage({ type: "streaming", epoch, attemptId: "privacy-pip" });
    controller.viewerMessage({ type: "pipCapability", epoch, supported: true }); await flushAsync();
    expect(controller.snapshot.privacyScreenActive).toBe(true);
    await controller.startPictureInPicture();
    expect(controller.snapshot).toMatchObject({ privacyScreen: true, privacyScreenActive: false, controlling: false });
    controller.viewerMessage({ type: "presentation", epoch, active: true });
    controller.setInteractive(false); controller.setForeground(false); await flushAsync();
    expect(value.setPrivacyScreen.mock.calls.every(call => call[3])).toBe(true);
    expect(value.stop).not.toHaveBeenCalled(); await controller.close();
  });

  it("composes inactive/background transport fences with the retained navigation PiP owner and foreground restoration", async () => {
    vi.useFakeTimers();
    const lifecycle = new MobileAppLifecycleCoordinator("active");
    const value = fixture(true, false, true, true);
    value.transport.isCurrent = () => lifecycle.transportForeground;
    const controller = new MobileRemoteDesktopController(value.transport, undefined, undefined, {
      nativePictureInPicture: true, requiresPlaybackSession: true, playback: async () => undefined
    }, undefined, { load: async () => true, save: async () => undefined });
    const commands: Record<string, unknown>[] = [];
    controller.setViewerSink(command => commands.push(command as Record<string, unknown>));
    await controller.open(); await flushAsync(); controller.viewerMessage({ type: "ready" });
    const epoch = commands.find(command => command.type === "init")?.epoch;
    controller.viewerMessage({ type: "iceConfig", epoch, attemptId: "navigation-owner" });
    controller.viewerMessage({ type: "streaming", epoch, attemptId: "navigation-owner" });
    controller.viewerMessage({ type: "pipCapability", epoch, supported: true });
    await controller.startPictureInPicture(); controller.viewerMessage({ type: "presentation", epoch, active: true });
    expect(await controller.leave()).toBe("retained");
    controller.setRouteFocused(false); controller.setInteractive(false);
    const inactive = lifecycle.transition("inactive");
    expect(inactive.transportForeground).toBeUndefined();
    const background = lifecycle.transition("background");
    controller.setForeground(background.transportForeground!);
    const returning = lifecycle.transition("active");
    controller.setForeground(returning.transportForeground!);
    expect(controller.snapshot.navigationRetained).toBe(true);
    expect(value.stop).not.toHaveBeenCalled();
    controller.setRouteFocused(true); controller.setInteractive(returning.interactive);
    await vi.advanceTimersByTimeAsync(0);
    expect(value.presentation.mock.calls.map(call => call[2])).toEqual([true, false]);
    expect(controller.snapshot).toMatchObject({ navigationRetained: false, exitStatus: "idle" });
    expect(value.start).toHaveBeenCalledTimes(1);
    expect(value.stop).not.toHaveBeenCalled();
    await controller.close();
    expect(value.stop.mock.calls.at(-1)?.[2]).toEqual({ lockScreen: false, controlGeneration: 0n });
  });

  it("adopts the per-target exit lock only after saving and reloads it in a new private store", async () => {
    const disk = new Map<string, string>();
    let write!: () => void;
    const storage = { getItem: async (key: string) => disk.get(key) ?? null,
      setItem: async (key: string, raw: string) => { await new Promise<void>(resolve => { write = resolve; }); disk.set(key, raw); } };
    const value = fixture(true, false, false, true);
    const preferences = createMobileRemoteDesktopLockPreferenceStore(storage);
    const controller = new MobileRemoteDesktopController(value.transport, undefined, undefined, undefined, undefined, preferences);
    await controller.open(); await flushAsync();
    expect(controller.snapshot.lockOnExit).toBe(false);
    const saving = controller.setLockOnExit(true); await flushAsync();
    expect(controller.snapshot.lockOnExit).toBe(false);
    write(); await saving;
    expect(controller.snapshot.lockOnExit).toBe(true);
    expect(await controller.leave(true)).toBe("closed");
    expect(value.stop.mock.calls[0]?.[2]).toEqual({ lockScreen: true, controlGeneration: 1n });
    await controller.close();
    const reopened = new MobileRemoteDesktopController(value.transport, undefined, undefined, undefined, undefined,
      createMobileRemoteDesktopLockPreferenceStore(storage));
    await reopened.open(); await flushAsync();
    expect(reopened.snapshot.lockOnExit).toBe(true);
    await reopened.close();
    expect(value.stop.mock.calls.at(-1)?.[2]).toEqual({ lockScreen: false, controlGeneration: 0n });
  });

  it("waits for an exact view-only exit acknowledgement and never automatically resends lock", async () => {
    vi.useFakeTimers();
    const value = fixture(true, false, false, true);
    let acknowledge!: () => void;
    value.stop.mockImplementationOnce(() => new Promise(resolve => { acknowledge = resolve; }));
    const controller = new MobileRemoteDesktopController(value.transport, undefined, undefined, undefined, undefined,
      { load: async () => true, save: async () => undefined });
    await controller.open(); await flushAsync();
    const leaving = controller.leave(true);
    expect(controller.snapshot.exitStatus).toBe("pending");
    expect(value.stop).toHaveBeenCalledWith(value.host, "lease-1", { lockScreen: true, controlGeneration: 1n }, expect.any(AbortSignal));
    await vi.advanceTimersByTimeAsync(9_000);
    expect(value.stop).toHaveBeenCalledTimes(1);
    expect(value.heartbeat).not.toHaveBeenCalled();
    acknowledge(); expect(await leaving).toBe("closed");
    expect(controller.snapshot.exitStatus).toBe("closed");
    await controller.close();
  });

  it("saves Linux exit lock in view only and sends the exact generated stop request", async () => {
    const value = fixture(false, false);
    value.host.platform = "linux"; value.capabilities.platform = "linux";
    value.capabilities.canControl = false; value.capabilities.lockOnExit = true;
    const credential: PairedCredential = { profileId: "profile-1", serverId: "server-1", deviceId: "phone-1",
      connectionId: "connection", origin: "https://node.example", displayName: "Node", authKey: "fixture-only" };
    const disk = new Map<string, string>();
    const preferences = createMobileRemoteDesktopLockPreferenceStore({ getItem: async key => disk.get(key) ?? null,
      setItem: async (key, raw) => { disk.set(key, raw); } });
    const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      expect(new URL(String(input)).pathname).toBe("/joko.v1.RemoteDesktopService/StopRemoteDesktop");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fixture-only");
      expect(fromBinary(StopRemoteDesktopRequestSchema, new Uint8Array(init?.body as Uint8Array)))
        .toMatchObject({ peer: value.route, leaseId: "lease-1", lockScreen: true, controlGeneration: 1n });
      return new Response(toBinary(StopRemoteDesktopResponseSchema, create(StopRemoteDesktopResponseSchema, { peer: value.route })),
        { headers: { "content-type": "application/proto" } });
    });
    value.stop.mockImplementation(async (host, leaseId, exit, signal) =>
      mobileNetwork.stopRemoteDesktop!(credential, host.route!, leaseId, exit, signal));
    const controller = new MobileRemoteDesktopController(value.transport, undefined, undefined, undefined, undefined, preferences);
    try {
      await controller.open(); await flushAsync();
      expect(controller.snapshot).toMatchObject({ status: "live", controlling: false, lockOnExitLoaded: true, lockOnExit: false });
      expect(controller.snapshot.capabilities).toMatchObject({ platform: "linux", lockOnExit: true,
        hostMute: false, privacyScreen: false, nativeCredentials: false });
      await controller.setLockOnExit(true);
      expect(controller.snapshot.lockOnExit).toBe(true);
      expect(await preferences.load({ ...value.transport.preferenceOwner, targetDeviceId: value.route.targetDeviceId })).toBe(true);
      expect(await controller.leave(true)).toBe("closed");
      expect(controller.snapshot.exitStatus).toBe("closed");
      expect(fetcher).toHaveBeenCalledTimes(1); expect(value.control).not.toHaveBeenCalled();
    } finally { await controller.close(); fetcher.mockRestore(); }
  });

  it("reports consumed lock authority honestly and reconnects a new session instead of retrying the old lock", async () => {
    vi.useFakeTimers();
    const value = fixture(true, false, false, true);
    value.stop.mockRejectedValueOnce(failure(RemoteDesktopFailureReason.LOCK_EXPIRED));
    const controller = new MobileRemoteDesktopController(value.transport, undefined, undefined, undefined, undefined,
      { load: async () => true, save: async () => undefined });
    await controller.open(); await flushAsync();
    expect(await controller.leave(true)).toBe("failed");
    expect(controller.snapshot).toMatchObject({ exitStatus: "failed", exitNotice: "lock-expired", controlling: false });
    await vi.advanceTimersByTimeAsync(9_000);
    expect(await controller.leave(true)).toBe("failed");
    expect(value.stop).toHaveBeenCalledTimes(1);
    expect(value.start).toHaveBeenCalledTimes(1);
    value.start.mockResolvedValueOnce(create(RemoteDesktopLeaseSchema, { ...value.lease, leaseId: "lease-2", controlGeneration: 2n }));
    await controller.reconnectAfterExitFailure();
    expect(value.start.mock.calls.at(-1)?.[2]).toBe(RemoteDesktopStartMode.NEW);
    expect(controller.snapshot).toMatchObject({ status: "live", exitStatus: "idle", exitNotice: undefined });
    expect(await controller.leave(true)).toBe("closed");
    expect(value.stop.mock.calls.at(-1)?.slice(1, 3)).toEqual(["lease-2", { lockScreen: true, controlGeneration: 2n }]);
    await controller.close();
  });

  it("drops old exit receipts when a newer controller occurrence replaces their authority", async () => {
    const value = fixture(true, false, false, true);
    let oldAck!: () => void;
    value.stop.mockImplementationOnce(() => new Promise(resolve => { oldAck = resolve; }));
    const controller = new MobileRemoteDesktopController(value.transport, undefined, undefined, undefined, undefined,
      { load: async () => true, save: async () => undefined });
    await controller.open(); await flushAsync();
    const leaving = controller.leave(true);
    await controller.open(); await flushAsync();
    oldAck(); expect(await leaving).toBe("failed");
    expect(controller.snapshot).toMatchObject({ status: "live", exitStatus: "idle" });
    await controller.close();
  });

  it("uses ordinary unlocked stop for background, authority retirement, capability absence and cleanup", async () => {
    for (const action of ["background", "authority", "cleanup", "unsupported"] as const) {
      const value = fixture(true, false, false, action !== "unsupported");
      const controller = new MobileRemoteDesktopController(value.transport, undefined, undefined, undefined, undefined,
        { load: async () => true, save: async () => undefined });
      await controller.open(); await flushAsync();
      controller.setInteractive(false);
      expect(value.stop).not.toHaveBeenCalled();
      controller.setInteractive(true);
      if (action === "background") controller.setForeground(false);
      else if (action === "authority") controller.authorityChanged();
      else if (action === "unsupported") await controller.leave(true);
      else await controller.close();
      expect(value.stop.mock.calls.at(-1)?.[2]).toEqual({ lockScreen: false, controlGeneration: 0n });
      await controller.close();
    }
  });

  it("retains only an actual active PiP navigation owner and uses its captured intent on termination", async () => {
    vi.useFakeTimers();
    const value = fixture(true, false, true, true);
    value.presentation.mockResolvedValue(create(RemoteDesktopControlStateSchema, { controlling: false, controlGeneration: 2n }));
    const controller = new MobileRemoteDesktopController(value.transport, undefined, undefined, {
      nativePictureInPicture: true, requiresPlaybackSession: true, playback: async () => undefined
    }, undefined, { load: async () => true, save: async () => undefined });
    const commands: Record<string, unknown>[] = [];
    controller.setViewerSink(command => commands.push(command as Record<string, unknown>));
    await controller.open(); await flushAsync(); controller.viewerMessage({ type: "ready" });
    const epoch = commands.find(command => command.type === "init")?.epoch;
    controller.viewerMessage({ type: "iceConfig", epoch, attemptId: "exit-pip" });
    controller.viewerMessage({ type: "streaming", epoch, attemptId: "exit-pip" });
    controller.viewerMessage({ type: "pipCapability", epoch, supported: true });
    await controller.startPictureInPicture();
    controller.viewerMessage({ type: "presentation", epoch, active: true });
    expect(await controller.leave()).toBe("retained");
    controller.setRouteFocused(false); controller.setInteractive(false); controller.setForeground(false);
    expect(value.stop).not.toHaveBeenCalled();
    controller.viewerMessage({ type: "presentation", epoch, active: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(value.stop.mock.calls[0]?.slice(1, 3)).toEqual(["lease-1", { lockScreen: true, controlGeneration: 2n }]);
    expect(controller.snapshot.exitStatus).toBe("closed");
    await controller.close();
  });

  it("restores retained PiP to the same inline viewer without exit lock and keeps plain background PiP termination unlocked", async () => {
    vi.useFakeTimers();
    for (const navigation of [true, false]) {
      const value = fixture(true, false, true, true);
      const controller = new MobileRemoteDesktopController(value.transport, undefined, undefined, {
        nativePictureInPicture: true, requiresPlaybackSession: true, playback: async () => undefined
      }, undefined, { load: async () => true, save: async () => undefined });
      const commands: Record<string, unknown>[] = [];
      controller.setViewerSink(command => commands.push(command as Record<string, unknown>));
      await controller.open(); await flushAsync(); controller.viewerMessage({ type: "ready" });
      const epoch = commands.find(command => command.type === "init")?.epoch;
      controller.viewerMessage({ type: "iceConfig", epoch, attemptId: "restore-pip" });
      controller.viewerMessage({ type: "streaming", epoch, attemptId: "restore-pip" });
      controller.viewerMessage({ type: "pipCapability", epoch, supported: true });
      await controller.startPictureInPicture(); controller.viewerMessage({ type: "presentation", epoch, active: true });
      if (navigation) {
        expect(await controller.leave()).toBe("retained");
        controller.setRouteFocused(false); controller.setInteractive(false);
        controller.setRouteFocused(true); controller.setInteractive(true);
        await vi.advanceTimersByTimeAsync(0);
        expect(value.stop).not.toHaveBeenCalled();
        expect(controller.snapshot.navigationRetained).toBe(false);
      } else {
        controller.setInteractive(false); controller.setForeground(false);
        controller.viewerMessage({ type: "presentation", epoch, active: false });
        await vi.advanceTimersByTimeAsync(0);
        expect(value.stop.mock.calls[0]?.[2]).toEqual({ lockScreen: false, controlGeneration: 0n });
      }
      await controller.close();
      expect(value.stop.mock.calls.every(call => !call[2].lockScreen)).toBe(true);
    }
  });

  it("loads host mute per target, persists before adoption, and restores it after reopening", async () => {
    const disk = new Map<string, string>();
    let completeWrite!: () => void;
    const preferences = createMobileRemoteDesktopHostMutePreferenceStore({
      getItem: async key => disk.get(key) ?? null,
      setItem: async (key, value) => {
        await new Promise<void>(resolve => { completeWrite = resolve; });
        disk.set(key, value);
      }
    });
    const value = fixture(true, true, false, true);
    const controller = new MobileRemoteDesktopController(value.transport, undefined, undefined, undefined, preferences);
    await controller.open(); await flushAsync();
    expect(controller.snapshot.hostMuteLoaded).toBe(true);
    expect(controller.snapshot.hostMute).toBe(false);
    const saving = controller.setHostMute(true);
    await flushAsync();
    expect(controller.snapshot.hostMute).toBe(false);
    expect(value.setHostMute.mock.calls.every(call => call[3] === false)).toBe(true);
    completeWrite(); await saving;
    expect(controller.snapshot.hostMute).toBe(true);
    expect(controller.snapshot.hostMuteActive).toBe(true);
    await controller.close(); await flushAsync();
    const freshPreferences = createMobileRemoteDesktopHostMutePreferenceStore({
      getItem: async key => disk.get(key) ?? null, setItem: async (key, raw) => { disk.set(key, raw); }
    });
    const second = new MobileRemoteDesktopController(value.transport, undefined, undefined, undefined, freshPreferences);
    await second.open(); await flushAsync();
    expect(second.snapshot.hostMute).toBe(true);
    expect(second.snapshot.hostMuteActive).toBe(true);
    expect(value.setHostMute.mock.calls.at(-1)?.slice(1, 4)).toEqual(["lease-1", 1n, true]);
    await second.close();
  });

  it("keeps the host mute picture and desired intent on an apply failure without heartbeat retry", async () => {
    vi.useFakeTimers();
    const value = fixture(true, true, false, true);
    value.heartbeat.mockResolvedValue(create(RemoteDesktopControlStateSchema, { controlling: true, controlGeneration: 1n }));
    const preferences: MobileRemoteDesktopHostMutePreferences = { load: async () => true, save: async () => undefined };
    value.setHostMute.mockRejectedValueOnce(failure(RemoteDesktopFailureReason.HOST_MUTE_UNAVAILABLE));
    const controller = new MobileRemoteDesktopController(value.transport, undefined, undefined, undefined, preferences);
    await controller.open(); await flushAsync();
    expect(controller.snapshot.hostMuteNotice).toBe("apply-failed");
    expect(controller.snapshot.status).toBe("live");
    expect(controller.snapshot.hostMute).toBe(true);
    expect(controller.snapshot.hostMuteActive).toBe(false);
    await vi.advanceTimersByTimeAsync(9_000);
    expect(value.setHostMute).toHaveBeenCalledTimes(1);
    await controller.retryHostMute();
    expect(controller.snapshot.hostMuteActive).toBe(true);
    expect(controller.snapshot.hostMuteNotice).toBeUndefined();
    await controller.close();
  });

  it("rejects retired host mute receipts and reapplies once on new control authority", async () => {
    vi.useFakeTimers();
    const value = fixture(true, true, false, true);
    let receipt!: (result: ReturnType<typeof create<typeof RemoteDesktopHostMuteResultSchema>>) => void;
    value.setHostMute.mockImplementationOnce(() => new Promise(resolve => { receipt = resolve; }));
    value.heartbeat.mockResolvedValue(create(RemoteDesktopControlStateSchema, { controlling: true, controlGeneration: 2n }));
    const preferences: MobileRemoteDesktopHostMutePreferences = { load: async () => true, save: async () => undefined };
    const controller = new MobileRemoteDesktopController(value.transport, undefined, undefined, undefined, preferences);
    await controller.open(); await flushAsync();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(controller.snapshot.hostMuteActive).toBe(false);
    receipt(create(RemoteDesktopHostMuteResultSchema, { enabled: true }));
    await vi.advanceTimersByTimeAsync(0);
    expect(value.setHostMute.mock.calls.at(-1)?.slice(1, 4)).toEqual(["lease-1", 2n, true]);
    expect(controller.snapshot.hostMuteActive).toBe(true);
    const attempts = value.setHostMute.mock.calls.length;
    await vi.advanceTimersByTimeAsync(6_000);
    expect(value.setHostMute).toHaveBeenCalledTimes(attempts);
    controller.setInteractive(false); await flushAsync();
    expect(controller.snapshot.hostMuteActive).toBe(false);
    expect(value.setHostMute.mock.calls.at(-1)?.[3]).toBe(false);
    controller.setInteractive(true); await flushAsync(); await flushAsync();
    expect(controller.snapshot.hostMuteActive).toBe(true);
    await controller.close();
  });

  it("requires explicit retry for host mute load and persistence failures", async () => {
    const value = fixture(true, false, false, true);
    const load = vi.fn(async () => false).mockRejectedValueOnce(new Error("disk unavailable"));
    const save = vi.fn(async () => undefined).mockRejectedValueOnce(new Error("disk full"));
    const controller = new MobileRemoteDesktopController(value.transport, undefined, undefined, undefined, { load, save });
    await controller.open(); await flushAsync();
    expect(controller.snapshot.hostMuteNotice).toBe("load-failed");
    expect(value.setHostMute).not.toHaveBeenCalled();
    await controller.retryHostMute();
    await controller.setHostMute(true);
    expect(controller.snapshot.hostMute).toBe(false);
    expect(controller.snapshot.hostMuteNotice).toBe("save-failed");
    await controller.retryHostMute();
    expect(controller.snapshot.hostMute).toBe(true);
    expect(controller.snapshot.hostMuteActive).toBe(false);
    await controller.setControl(true); await flushAsync();
    expect(value.setHostMute.mock.calls.at(-1)?.[3]).toBe(true);
    expect(controller.snapshot.hostMuteActive).toBe(true);
    await controller.close();
  });

  it("does not send host mute when the capability is unavailable", async () => {
    const value = fixture(true, true);
    const save = vi.fn(async () => undefined);
    const controller = new MobileRemoteDesktopController(value.transport, undefined, undefined, undefined,
      { load: async () => true, save });
    await controller.open(); await flushAsync();
    await controller.setHostMute(false);
    expect(save).not.toHaveBeenCalled();
    expect(value.setHostMute).not.toHaveBeenCalled();
    await controller.close();
  });

  it("uses NEW after an explicit background stop and RESUME after an unstopped network pause", async () => {
    vi.useFakeTimers();
    const background = fixture();
    const first = new MobileRemoteDesktopController(background.transport);
    await first.open();
    expect(background.start.mock.calls[0]?.[2]).toBe(RemoteDesktopStartMode.NEW);
    first.setForeground(false);
    expect(background.stop).toHaveBeenCalledTimes(1);
    first.setForeground(true);
    await Promise.resolve(); await Promise.resolve();
    expect(background.start.mock.calls[1]?.[2]).toBe(RemoteDesktopStartMode.NEW);
    await first.close();

    const network = fixture();
    const second = new MobileRemoteDesktopController(network.transport);
    await second.open();
    second.setOnline(false);
    expect(network.stop).not.toHaveBeenCalled();
    second.setOnline(true);
    await Promise.resolve(); await Promise.resolve();
    expect(network.start.mock.calls[1]?.[2]).toBe(RemoteDesktopStartMode.RESUME);
    await second.close();
  });

  it("rejects stale viewer epochs before they can promote old media", async () => {
    vi.useFakeTimers();
    const { transport } = fixture();
    const controller = new MobileRemoteDesktopController(transport);
    const commands: Record<string, unknown>[] = [];
    controller.setViewerSink((command) => commands.push(command as Record<string, unknown>));
    await controller.open();
    controller.viewerMessage({ type: "ready" });
    const epoch = commands.find((command) => command.type === "init")?.epoch;
    expect(typeof epoch).toBe("string");
    controller.viewerMessage({ type: "streaming", epoch: "old-lease", attemptId: "1" });
    expect(controller.snapshot.media).not.toBe("webrtc");
    controller.viewerMessage({ type: "streaming", epoch, attemptId: "1" });
    expect(controller.snapshot.media).not.toBe("webrtc");
    controller.viewerMessage({ type: "iceConfig", epoch, attemptId: "1" });
    controller.viewerMessage({ type: "streaming", epoch, attemptId: "1" });
    expect(controller.snapshot.media).toBe("webrtc");
    controller.viewerMessage({ type: "reconnecting", epoch, attemptId: "1" });
    expect(controller.snapshot).toMatchObject({ status: "reconnecting", media: "jpeg" });
    controller.viewerMessage({ type: "streaming", epoch, attemptId: "1" });
    expect(controller.snapshot).toMatchObject({ status: "live", media: "webrtc" });
    await controller.close();
  });

  it("requires the preferred target and never falls back to a different desktop", async () => {
    const value = fixture();
    const controller = new MobileRemoteDesktopController(value.transport, "desktop-missing");
    await controller.open();
    expect(controller.snapshot).toMatchObject({ status: "unsupported", notice: "unavailable", hosts: [] });
    expect(value.start).not.toHaveBeenCalled();
    await controller.close();
  });

  it("releases control on renderer loss and gives each renderer occurrence a disjoint input range", async () => {
    vi.useFakeTimers();
    const value = fixture(true, true);
    const commands: Record<string, unknown>[] = [];
    const controller = new MobileRemoteDesktopController(value.transport);
    controller.setViewerSink((command) => commands.push(command as Record<string, unknown>));
    await controller.open();
    controller.viewerMessage({ type: "ready" });
    const first = commands.find((command) => command.type === "init")!;
    controller.viewerProcessLost();
    await flushAsync();
    expect(value.control).toHaveBeenCalledWith(value.host, value.lease.leaseId, false, expect.any(AbortSignal));
    expect(controller.snapshot).toMatchObject({ controlling: false, notice: "viewer-restarted" });
    controller.viewerMessage({ type: "ready" });
    const inits = commands.filter((command) => command.type === "init");
    const second = inits.at(-1)!;
    expect(second.epoch).not.toBe(first.epoch);
    expect(second.sequenceBase).toBeGreaterThan(first.sequenceLimit as number);
    await controller.close();
  });

  it("fences signaling to the current renderer media attempt", async () => {
    const value = fixture();
    const controller = new MobileRemoteDesktopController(value.transport);
    controller.setViewerSink(() => undefined);
    await controller.open();
    controller.viewerMessage({ type: "ready" });
    const commands: Record<string, unknown>[] = [];
    controller.setViewerSink((command) => commands.push(command as Record<string, unknown>));
    controller.viewerMessage({ type: "ready" });
    const currentEpoch = commands.find((command) => command.type === "init")?.epoch;
    controller.viewerMessage({ type: "iceConfig", epoch: currentEpoch, attemptId: "old" });
    controller.viewerMessage({ type: "iceConfig", epoch: currentEpoch, attemptId: "current" });
    controller.viewerMessage({ type: "offer", epoch: currentEpoch, attemptId: "old", sdp: "old-offer" });
    controller.viewerMessage({ type: "offer", epoch: currentEpoch, attemptId: "current", sdp: "current-offer" });
    await flushAsync();
    expect(value.offer).toHaveBeenCalledTimes(1);
    expect(value.offer).toHaveBeenCalledWith(value.host, value.lease.leaseId,
      "current", "current-offer", undefined, false, expect.any(AbortSignal));
    await controller.close();
  });

  it("uses one fresh NEW fallback only for typed lease expiry, never for STOPPED", async () => {
    const expired = fixture();
    expired.start.mockResolvedValueOnce(expired.lease)
      .mockRejectedValueOnce(failure(RemoteDesktopFailureReason.LEASE_EXPIRED))
      .mockResolvedValueOnce(expired.lease);
    const recovering = new MobileRemoteDesktopController(expired.transport);
    await recovering.open();
    recovering.setOnline(false);
    recovering.setOnline(true);
    await flushAsync();
    expect(expired.start.mock.calls.map((call) => call[2])).toEqual([
      RemoteDesktopStartMode.NEW, RemoteDesktopStartMode.RESUME, RemoteDesktopStartMode.NEW
    ]);
    await recovering.close();

    const stopped = fixture();
    stopped.start.mockResolvedValueOnce(stopped.lease)
      .mockRejectedValueOnce(failure(RemoteDesktopFailureReason.STOPPED));
    const terminal = new MobileRemoteDesktopController(stopped.transport);
    await terminal.open();
    terminal.setOnline(false);
    terminal.setOnline(true);
    await flushAsync();
    expect(stopped.start.mock.calls.map((call) => call[2])).toEqual([
      RemoteDesktopStartMode.NEW, RemoteDesktopStartMode.RESUME
    ]);
    expect(terminal.snapshot).toMatchObject({ status: "stopped", notice: "stopped" });
    await terminal.close();
  });

  it("freezes and releases input while inactive, but stops only in background", async () => {
    const value = fixture(true, true);
    const controller = new MobileRemoteDesktopController(value.transport);
    controller.setViewerSink(() => undefined);
    await controller.open();
    controller.viewerMessage({ type: "ready" });
    value.stop.mockClear();
    value.input.mockClear();
    controller.setInteractive(false);
    await flushAsync();
    expect(value.stop).not.toHaveBeenCalled();
    expect(value.input).toHaveBeenCalledWith(value.host, value.lease.leaseId, 999_999_999n,
      [expect.objectContaining({ event: expect.objectContaining({ case: "release" }) })], expect.any(AbortSignal));
    controller.setForeground(false);
    expect(value.stop).toHaveBeenCalledTimes(1);
    controller.setForeground(true);
    controller.setInteractive(true);
    await flushAsync();
    expect(value.start.mock.calls.at(-1)?.[2]).toBe(RemoteDesktopStartMode.NEW);
    await controller.close();
  });

  it("keeps exactly one JPEG frame in flight through renderer presentation", async () => {
    vi.useFakeTimers();
    const value = fixture(false);
    value.frame.mockResolvedValue(create(RemoteDesktopFrameResultSchema, {
      frame: create(RemoteDesktopFrameSchema, { jpeg: Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]) })
    }));
    const commands: Record<string, unknown>[] = [];
    const controller = new MobileRemoteDesktopController(value.transport);
    controller.setViewerSink((command) => commands.push(command as Record<string, unknown>));
    await controller.open();
    controller.viewerMessage({ type: "ready" });
    const epoch = commands.find((command) => command.type === "init")?.epoch;
    controller.viewerMessage({ type: "fallback", epoch, attemptId: null });
    await flushAsync();
    const firstFrame = commands.find((command) => command.type === "frame")!;
    expect(value.frame).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(value.frame).toHaveBeenCalledTimes(1);
    controller.viewerMessage({ type: "framePresented", epoch, frameId: "stale", presented: true });
    await vi.advanceTimersByTimeAsync(250);
    expect(value.frame).toHaveBeenCalledTimes(1);
    controller.viewerMessage({ type: "framePresented", epoch, frameId: firstFrame.frameId, presented: true });
    await vi.advanceTimersByTimeAsync(250);
    expect(value.frame).toHaveBeenCalledTimes(2);
    expect(controller.snapshot.hasFrame).toBe(true);
    await controller.close();
  });

  it("negotiates cursor overlay for offers and JPEG frames and forwards a bounded cursor", async () => {
    vi.useFakeTimers();
    const value = fixture(false, false, false, true);
    value.frame.mockResolvedValue(create(RemoteDesktopFrameResultSchema, {
      frame: create(RemoteDesktopFrameSchema, {
        jpeg: Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]),
        cursor: create(RemoteDesktopCursorSchema, {
          visible: true, x: 0.25, y: 0.75, width: 16, height: 20, hotX: 2, hotY: 3, png: cursorPng()
        })
      })
    }));
    const commands: Record<string, unknown>[] = [];
    const controller = new MobileRemoteDesktopController(value.transport);
    controller.setViewerSink((command) => commands.push(command as Record<string, unknown>));
    await controller.open();
    await flushAsync();
    controller.viewerMessage({ type: "ready" });
    const init = commands.find((command) => command.type === "init")!;
    expect(init).toMatchObject({ cursorOverlay: true, webrtc: false });
    controller.viewerMessage({ type: "fallback", epoch: init.epoch, attemptId: null });
    await flushAsync();
    expect(value.frame).toHaveBeenCalledWith(value.host, value.lease.leaseId, true, expect.any(AbortSignal));
    expect(commands.find((command) => command.type === "frame")).toMatchObject({
      cursor: { visible: true, x: 0.25, y: 0.75, width: 16, height: 20, hotX: 2, hotY: 3 }
    });
    await controller.close();
  });

  it("loads and retries display modes without disturbing the active lease", async () => {
    const value = fixture(true, true, false, true);
    value.listDisplayModes.mockRejectedValueOnce(new Error("temporary"));
    const controller = new MobileRemoteDesktopController(value.transport);
    await controller.open();
    await flushAsync();
    expect(controller.snapshot).toMatchObject({
      status: "live", displayModesStatus: "error", displayModeNotice: "load-failed"
    });
    await controller.loadDisplayModes();
    expect(controller.snapshot.displayModesStatus).toBe("ready");
    expect(controller.snapshot.displayModes.map((mode) => mode.modeId)).toEqual(["10", "20"]);
    expect(value.stop).not.toHaveBeenCalled();
    await controller.close();
  });

  it("preserves a Linux portal lease and settings intent through capture pending, then adopts only its actual presented frame", async () => {
    vi.useFakeTimers(); const value = fixture(true, false, true, false); value.capabilities.platform = "linux"; value.capabilities.canControl = false;
    value.frame.mockRejectedValue(failure(RemoteDesktopFailureReason.CAPTURE_PENDING));
    value.offer.mockRejectedValue(failure(RemoteDesktopFailureReason.CAPTURE_PENDING));
    const commands: Record<string, unknown>[] = []; const controller = new MobileRemoteDesktopController(value.transport);
    controller.setViewerSink(command => commands.push(command as Record<string, unknown>));
    await controller.open(); controller.viewerMessage({ type: "ready" }); await flushAsync();
    const epoch = commands.filter(command => command.type === "init").at(-1)!.epoch;
    controller.updateVideoSettings({ fps: 60, quality: "hd", audio: false });
    controller.viewerMessage({ type: "iceConfig", epoch, attemptId: "portal" }); await flushAsync();
    controller.viewerMessage({ type: "offer", epoch, attemptId: "portal", sdp: "offer" }); await flushAsync();
    expect(commands).toContainEqual({ type: "fallback", epoch, attemptId: "portal", retry: true, capturePending: true });
    controller.viewerMessage({ type: "fallback", epoch, attemptId: "portal", reason: "capture-pending" });
    await vi.advanceTimersByTimeAsync(75000);
    expect(controller.snapshot).toMatchObject({ status: "capture-pending", controlling: false, hasFrame: false, videoSettingsBusy: true, notice: "capture-pending", videoSettings: { fps: 60, quality: "hd" } });
    for (const locale of ["en", "zh-CN", "zh-TW", "ja", "ko"] as const) {
      const copy = mobileRemoteDesktopCopy(locale);
      expect(mobileRemoteDesktopStatusLabel(controller.snapshot, copy)).toBe(copy.capturePending);
      expect(mobileRemoteDesktopNoticeLabel(controller.snapshot.notice, copy)).toBe(copy.capturePending);
    }
    expect(value.start).toHaveBeenCalledTimes(1); expect(value.heartbeat.mock.calls.length).toBeGreaterThan(20); expect(value.stop).not.toHaveBeenCalled();
    value.frame.mockResolvedValue(create(RemoteDesktopFrameResultSchema, { frame: { jpeg: Uint8Array.from([255, 216, 255, 217]) } }));
    await vi.advanceTimersByTimeAsync(250);
    const frame = commands.filter(command => command.type === "frame").at(-1)!;
    controller.viewerMessage({ type: "framePresented", epoch, frameId: frame.frameId, presented: true });
    expect(controller.snapshot).toMatchObject({ status: "live", hasFrame: true, videoSettingsBusy: false, controlling: false, notice: undefined });
    await controller.close();
  });

  it("keeps portal denial terminal and ignores pending from a retired viewer occurrence", async () => {
    vi.useFakeTimers(); const value = fixture(true, false, true, false); value.capabilities.platform = "linux"; value.capabilities.canControl = false;
    value.frame.mockRejectedValue(failure(RemoteDesktopFailureReason.CAPTURE_PENDING));
    value.offer.mockRejectedValue(failure(RemoteDesktopFailureReason.CAPTURE_PENDING));
    const commands: Record<string, unknown>[] = []; const controller = new MobileRemoteDesktopController(value.transport);
    controller.setViewerSink(command => commands.push(command as Record<string, unknown>));
    await controller.open(); controller.viewerMessage({ type: "ready" }); await flushAsync();
    const epoch = commands.filter(command => command.type === "init").at(-1)!.epoch;
    controller.viewerMessage({ type: "iceConfig", epoch, attemptId: "portal" }); await flushAsync();
    controller.viewerMessage({ type: "offer", epoch, attemptId: "portal", sdp: "offer" }); await flushAsync();
    controller.viewerMessage({ type: "fallback", epoch, attemptId: "portal", reason: "capture-pending" });
    await vi.advanceTimersByTimeAsync(250);
    expect(controller.snapshot.status).toBe("capture-pending");
    value.frame.mockRejectedValue(failure(RemoteDesktopFailureReason.SCREEN_PERMISSION_REQUIRED));
    await vi.advanceTimersByTimeAsync(250); expect(controller.snapshot).toMatchObject({ status: "permission", notice: "screen-permission" });
    controller.setPermissionGuideVisible(true); await flushAsync();
    expect(value.transport.permissions).toHaveBeenCalledOnce();
    expect(controller.snapshot.permissionCheckStatus).toBe("ready");
    controller.viewerMessage({ type: "fallback", epoch, attemptId: "portal", reason: "capture-pending" });
    await vi.advanceTimersByTimeAsync(10000); expect(controller.snapshot.status).toBe("permission"); expect(value.start).toHaveBeenCalledTimes(1);
    await controller.close();
  });

  it.each(["restore", "physical-current"] as const)("fits and returns through %s with released input, actual geometry and source-based recovery", async (restoration) => {
    const value = fixture(true, true, false, true);
    value.capabilities.platform = "linux"; value.host.platform = "linux";
    value.capabilities.viewerDisplay = true; value.capabilities.viewerDisplayRestore = true;
    value.capabilities.resolutionRestore = true;
    value.heartbeat.mockResolvedValue(create(RemoteDesktopControlStateSchema, { controlling: true, controlGeneration: 1n }));
    value.fitViewerDisplay.mockResolvedValue(create(RemoteDesktopViewerDisplayResultSchema, { lease: {
      ...value.lease, controlling: false, controlGeneration: 2n,
      display: { ...value.lease.display!, displayId: "mirror-1", width: 888, height: 1920 }
    } }));
    value.restoreViewerDisplay.mockResolvedValue(create(RemoteDesktopViewerDisplayResultSchema, { lease: { ...value.lease, controlling: false, controlGeneration: 4n } }));
    value.setDisplayMode.mockResolvedValue(create(RemoteDesktopDisplayModeResultSchema, { lease: { ...value.lease, controlling: false, controlGeneration: 4n } }));
    value.control.mockResolvedValueOnce(create(RemoteDesktopControlStateSchema, { controlling: true, controlGeneration: 3n }))
      .mockResolvedValueOnce(create(RemoteDesktopControlStateSchema, { controlling: true, controlGeneration: 5n }));
    const commands: Record<string, unknown>[] = [];
    const controller = new MobileRemoteDesktopController(value.transport);
    controller.setViewerSink(command => commands.push(command as Record<string, unknown>));
    await controller.open(); await flushAsync(); controller.viewerMessage({ type: "ready" });
    const oldInit = commands.filter(command => command.type === "init").at(-1)!;
    await controller.fitViewerDisplay(390, 844); await flushAsync();
    expect(value.fitViewerDisplay).toHaveBeenCalledWith(value.host, value.lease.leaseId, 1n, 888, 1920, expect.any(AbortSignal));
    expect(value.input).toHaveBeenCalledWith(value.host, value.lease.leaseId, expect.any(BigInt),
      [expect.objectContaining({ event: { case: "release", value: expect.any(Object) } })], expect.any(AbortSignal));
    expect(value.input.mock.invocationCallOrder[0]).toBeLessThan(value.fitViewerDisplay.mock.invocationCallOrder[0]!);
    expect(controller.snapshot).toMatchObject({ status: "live", selectedDisplayId: "display-1", viewerDisplayFitted: true,
      controlling: true, wantedControl: true, displayModeBusy: false });
    const fittedInit = commands.filter(command => command.type === "init").at(-1)!;
    expect(fittedInit).toMatchObject({ width: 888, height: 1920 }); expect(fittedInit.epoch).not.toBe(oldInit.epoch);
    if (restoration === "restore") {
      await controller.restoreViewerDisplay();
      expect(value.restoreViewerDisplay).toHaveBeenCalledWith(value.host, value.lease.leaseId, 3n, expect.any(AbortSignal));
    } else {
      await controller.setDisplayMode("10");
      expect(value.setDisplayMode).toHaveBeenCalledWith(value.host, value.lease.leaseId, 3n, "10", true, expect.any(AbortSignal));
    }
    await flushAsync();
    expect(controller.snapshot).toMatchObject({ selectedDisplayId: "display-1", viewerDisplayFitted: false, controlling: true });
    expect(commands.filter(command => command.type === "init").at(-1)).toMatchObject({ width: 1920, height: 1080 });
    expect(value.start).toHaveBeenCalledTimes(1); expect(value.stop).not.toHaveBeenCalled();
    await controller.close();
  });

  it("adopts adjusted Mac mirror geometry on repeat Fit and restores its physical source without replacing the lease", async () => {
    const value = fixture(true, true, false, true);
    value.capabilities.viewerDisplay = true; value.capabilities.viewerDisplayRestore = true;
    value.heartbeat.mockResolvedValue(create(RemoteDesktopControlStateSchema, { controlling: true, controlGeneration: 1n }));
    value.fitViewerDisplay.mockResolvedValueOnce(create(RemoteDesktopViewerDisplayResultSchema, { lease: {
      ...value.lease, controlling: false, controlGeneration: 2n,
      display: { ...value.lease.display!, displayId: "mirror-1", width: 768, height: 1536 }
    } })).mockResolvedValueOnce(create(RemoteDesktopViewerDisplayResultSchema, { lease: {
      ...value.lease, controlling: false, controlGeneration: 4n,
      display: { ...value.lease.display!, displayId: "mirror-1", width: 1536, height: 768 }
    } }));
    value.restoreViewerDisplay.mockResolvedValue(create(RemoteDesktopViewerDisplayResultSchema, {
      lease: { ...value.lease, controlling: false, controlGeneration: 6n }
    }));
    value.control.mockResolvedValueOnce(create(RemoteDesktopControlStateSchema, { controlling: true, controlGeneration: 3n }))
      .mockResolvedValueOnce(create(RemoteDesktopControlStateSchema, { controlling: true, controlGeneration: 5n }))
      .mockResolvedValueOnce(create(RemoteDesktopControlStateSchema, { controlling: true, controlGeneration: 7n }));
    const commands: Record<string, unknown>[] = [], controller = new MobileRemoteDesktopController(value.transport);
    controller.setViewerSink(command => commands.push(command as Record<string, unknown>));
    await controller.open(); await flushAsync(); controller.viewerMessage({ type: "ready" });
    const initial = commands.filter(command => command.type === "init").at(-1)!;
    await controller.fitViewerDisplay(400, 800); await flushAsync();
    expect(value.fitViewerDisplay).toHaveBeenNthCalledWith(1, value.host, "lease-1", 1n, 960, 1920, expect.any(AbortSignal));
    expect(value.input.mock.invocationCallOrder[0]).toBeLessThan(value.fitViewerDisplay.mock.invocationCallOrder[0]!);
    expect(controller.snapshot).toMatchObject({ status: "live", controlling: true, selectedDisplayId: "display-1", viewerDisplayFitted: true });
    const portrait = commands.filter(command => command.type === "init").at(-1)!;
    expect(portrait).toMatchObject({ width: 768, height: 1536 }); expect(portrait.epoch).not.toBe(initial.epoch);
    controller.viewerMessage({ type: "framePresented", epoch: initial.epoch, attemptId: null, frameId: 1 });
    expect(controller.snapshot.hasFrame).toBe(false);
    await controller.fitViewerDisplay(800, 400); await flushAsync();
    expect(value.fitViewerDisplay).toHaveBeenNthCalledWith(2, value.host, "lease-1", 3n, 1920, 960, expect.any(AbortSignal));
    expect(commands.filter(command => command.type === "init").at(-1)).toMatchObject({ width: 1536, height: 768 });
    await controller.restoreViewerDisplay(); await flushAsync();
    expect(value.restoreViewerDisplay).toHaveBeenCalledWith(value.host, "lease-1", 5n, expect.any(AbortSignal));
    expect(controller.snapshot).toMatchObject({ status: "live", controlling: true, selectedDisplayId: "display-1", viewerDisplayFitted: false });
    expect(commands.filter(command => command.type === "init").at(-1)).toMatchObject({ width: 1920, height: 1080 });
    expect(value.start).toHaveBeenCalledTimes(1); expect(value.stop).not.toHaveBeenCalled(); await controller.close();
  });

  it.each([
    { reason: "fractional Mac geometry", platform: "darwin", width: 768.5, height: 1536 },
    { reason: "oversized Mac geometry", platform: "darwin", width: 4097, height: 4097 },
    { reason: "wrong Mac aspect", platform: "darwin", width: 768, height: 1500 },
    { reason: "adjusted Linux geometry", platform: "linux", width: 768, height: 1536 },
    { reason: "physical source ID", platform: "darwin", width: 960, height: 1920, displayId: "display-1" },
    { reason: "another physical ID", platform: "darwin", width: 960, height: 1920, displayId: "display-2" },
    { reason: "replacement lease", platform: "darwin", width: 960, height: 1920, leaseId: "replacement" },
    { reason: "control-bearing receipt", platform: "darwin", width: 960, height: 1920, controlling: true },
    { reason: "stale control generation", platform: "darwin", width: 960, height: 1920, controlGeneration: 1n }
  ])("retains original cleanup responsibility after $reason in a Fit receipt", async receipt => {
    const value = fixture(true, true, false, true);
    value.host.platform = receipt.platform; value.capabilities.platform = receipt.platform; value.capabilities.viewerDisplay = true;
    value.capabilities.displays.push(create(RemoteDesktopDisplaySchema, { ...value.lease.display!, displayId: "display-2" }));
    value.heartbeat.mockResolvedValue(create(RemoteDesktopControlStateSchema, { controlling: true, controlGeneration: 1n }));
    value.fitViewerDisplay.mockResolvedValue(create(RemoteDesktopViewerDisplayResultSchema, { lease: {
      ...value.lease, leaseId: receipt.leaseId ?? value.lease.leaseId, controlling: receipt.controlling ?? false,
      controlGeneration: receipt.controlGeneration ?? 2n,
      display: { ...value.lease.display!, displayId: receipt.displayId ?? "mirror-1", width: receipt.width, height: receipt.height }
    } }));
    const commands: Record<string, unknown>[] = [], controller = new MobileRemoteDesktopController(value.transport);
    controller.setViewerSink(command => commands.push(command as Record<string, unknown>));
    await controller.open(); await controller.selectDisplay("display-1"); await flushAsync(); controller.viewerMessage({ type: "ready" });
    const inits = commands.filter(command => command.type === "init").length;
    await controller.fitViewerDisplay(400, 800);
    expect(controller.snapshot).toMatchObject({ status: "error", controlling: false, wantedControl: false, displayModeNotice: "change-failed", selectedDisplayId: "display-1" });
    expect(commands.filter(command => command.type === "init")).toHaveLength(inits); expect(value.control).not.toHaveBeenCalled();
    expect(value.start).toHaveBeenCalledTimes(1); await controller.close();
    expect(value.stop).toHaveBeenCalledWith(value.host, "lease-1", { lockScreen: false, controlGeneration: 0n });
  });

  it("rejects a different mirror ID on repeat Mac Fit and retains the captured lease for cleanup", async () => {
    const value = fixture(true, true, false, true); value.capabilities.viewerDisplay = true;
    value.heartbeat.mockResolvedValue(create(RemoteDesktopControlStateSchema, { controlling: true, controlGeneration: 1n }));
    value.fitViewerDisplay.mockResolvedValueOnce(create(RemoteDesktopViewerDisplayResultSchema, { lease: { ...value.lease,
      controlling: false, controlGeneration: 2n, display: { ...value.lease.display!, displayId: "mirror-1", width: 768, height: 1536 }
    } })).mockResolvedValueOnce(create(RemoteDesktopViewerDisplayResultSchema, { lease: { ...value.lease,
      controlling: false, controlGeneration: 4n, display: { ...value.lease.display!, displayId: "mirror-2", width: 1536, height: 768 }
    } }));
    value.control.mockResolvedValue(create(RemoteDesktopControlStateSchema, { controlling: true, controlGeneration: 3n }));
    const controller = new MobileRemoteDesktopController(value.transport); await controller.open(); await flushAsync();
    await controller.fitViewerDisplay(400, 800); expect(controller.snapshot.viewerDisplayFitted).toBe(true);
    await controller.fitViewerDisplay(800, 400);
    expect(controller.snapshot).toMatchObject({ status: "error", controlling: false, wantedControl: false, selectedDisplayId: "display-1" });
    expect(value.control).toHaveBeenCalledTimes(1); await controller.close();
    expect(value.stop).toHaveBeenCalledWith(value.host, "lease-1", { lockScreen: false, controlGeneration: 0n });
  });

  it("resumes a fitted network pause through the physical source with fresh restored geometry", async () => {
    const value = fixture(true, true, false, true);
    value.capabilities.platform = "linux"; value.host.platform = "linux";
    value.capabilities.viewerDisplay = true; value.capabilities.viewerDisplayRestore = true;
    value.capabilities.resolutionRestore = true;
    value.heartbeat.mockResolvedValue(create(RemoteDesktopControlStateSchema, { controlling: true, controlGeneration: 1n }));
    value.fitViewerDisplay.mockResolvedValue(create(RemoteDesktopViewerDisplayResultSchema, { lease: {
      ...value.lease, controlling: false, controlGeneration: 2n,
      display: { ...value.lease.display!, displayId: "mirror-1", width: 960, height: 1920 }
    } }));
    value.control.mockResolvedValue(create(RemoteDesktopControlStateSchema, { controlling: true, controlGeneration: 3n }));
    const commands: Record<string, unknown>[] = [];
    const controller = new MobileRemoteDesktopController(value.transport);
    controller.setViewerSink(command => commands.push(command as Record<string, unknown>));
    await controller.open(); await flushAsync(); controller.viewerMessage({ type: "ready" });
    await controller.fitViewerDisplay(400, 800); await flushAsync();
    expect(controller.snapshot.viewerDisplayFitted).toBe(true);
    value.start.mockResolvedValueOnce(create(RemoteDesktopLeaseSchema, { ...value.lease,
      leaseId: "restored-resume", controlling: false, controlGeneration: 4n }));
    value.heartbeat.mockResolvedValue(create(RemoteDesktopControlStateSchema, { controlling: false, controlGeneration: 4n }));
    controller.setOnline(false); controller.setOnline(true); await flushAsync();
    expect(value.start.mock.calls[1]).toEqual([value.host, "display-1", RemoteDesktopStartMode.RESUME, expect.any(AbortSignal)]);
    expect(controller.snapshot).toMatchObject({ status: "live", selectedDisplayId: "display-1", viewerDisplayFitted: false, controlling: false });
    expect(commands.filter(command => command.type === "init").at(-1)).toMatchObject({ width: 1920, height: 1080 });
    expect(value.stop).not.toHaveBeenCalled(); expect(value.restoreViewerDisplay).not.toHaveBeenCalled();
    await controller.close();
    expect(value.stop).toHaveBeenCalledWith(value.host, "restored-resume", { lockScreen: false, controlGeneration: 0n });
  });

  it("preserves a withdrawn control intent while a mirror write is pending", async () => {
    const value = fixture(true, true, false, true); value.capabilities.platform = "linux"; value.capabilities.viewerDisplay = true;
    value.heartbeat.mockResolvedValue(create(RemoteDesktopControlStateSchema, { controlling: true, controlGeneration: 1n }));
    let finish!: (result: Awaited<ReturnType<NonNullable<MobileRemoteDesktopTransport["fitViewerDisplay"]>>>) => void;
    value.fitViewerDisplay.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const controller = new MobileRemoteDesktopController(value.transport); await controller.open(); await flushAsync();
    const pending = controller.fitViewerDisplay(400, 800); await flushAsync(); await controller.setControl(false);
    finish(create(RemoteDesktopViewerDisplayResultSchema, { lease: { ...value.lease, controlling: false, controlGeneration: 2n,
      display: { ...value.lease.display!, displayId: "mirror-1", width: 960, height: 1920 } } }));
    await pending;
    expect(controller.snapshot).toMatchObject({ controlling: false, wantedControl: false, viewerDisplayFitted: true });
    expect(value.control).not.toHaveBeenCalled(); await controller.close();
  });

  it.each(["linux", "darwin"])("keeps an unknown %s mirror write for explicit actual cleanup without replay or replacement", async platform => {
    vi.useFakeTimers(); const value = fixture(true, true, false, true);
    value.capabilities.platform = platform; value.capabilities.viewerDisplay = true;
    value.heartbeat.mockResolvedValue(create(RemoteDesktopControlStateSchema, { controlling: true, controlGeneration: 1n }));
    value.fitViewerDisplay.mockRejectedValueOnce(new Error("Receipt unavailable"));
    const controller = new MobileRemoteDesktopController(value.transport); await controller.open(); await flushAsync();
    await controller.fitViewerDisplay(400, 800); await vi.advanceTimersByTimeAsync(8000);
    expect(controller.snapshot).toMatchObject({ status: "error", controlling: false, wantedControl: false });
    expect(value.start).toHaveBeenCalledTimes(1); expect(value.fitViewerDisplay).toHaveBeenCalledTimes(1);
    value.stop.mockRejectedValueOnce(failure(RemoteDesktopFailureReason.DISPLAY_RESTORE_UNAVAILABLE));
    await controller.retry(); await flushAsync();
    expect(controller.snapshot).toMatchObject({ status: "error", displayModeNotice: "restore-unavailable" });
    expect(value.start).toHaveBeenCalledTimes(1);
    await controller.retry(); await flushAsync();
    expect(value.start).toHaveBeenCalledTimes(2); expect(value.start.mock.calls[1]?.[1]).toBe("display-1");
    expect(value.start.mock.calls[1]?.[2]).toBe(RemoteDesktopStartMode.NEW); expect(value.fitViewerDisplay).toHaveBeenCalledTimes(1);
    await controller.close();
  });

  it.each(["darwin", "linux"])("adopts %s temporary geometry on the same lease, retires its old viewer and restores only wanted control", async platform => {
    const value = fixture(true, true, false, true); value.capabilities.resolutionRestore = true;
    value.host.platform = platform; value.capabilities.platform = platform;
    if (platform === "linux") {
      value.capabilities.hostMute = false; value.capabilities.lockOnExit = false; value.capabilities.privacyScreen = false;
    }
    const nextLease = create(RemoteDesktopLeaseSchema, { ...value.lease, controlling: false, controlGeneration: 2n,
      display: { ...value.lease.display!, width: 1280, height: 720 } });
    value.setDisplayMode.mockResolvedValue(create(RemoteDesktopDisplayModeResultSchema, { lease: nextLease }));
    value.control.mockResolvedValue(create(RemoteDesktopControlStateSchema, { controlling: true, controlGeneration: 3n }));
    const commands: Record<string, unknown>[] = [];
    const controller = new MobileRemoteDesktopController(value.transport); controller.setViewerSink(command => commands.push(command as Record<string, unknown>));
    await controller.open(); await flushAsync(); controller.viewerMessage({ type: "ready" });
    const oldInit = commands.filter(command => command.type === "init").at(-1)!;
    await controller.setDisplayMode("20"); await flushAsync();
    expect(value.setDisplayMode).toHaveBeenCalledWith(value.host, value.lease.leaseId, 1n, "20", true, expect.any(AbortSignal));
    expect(value.start).toHaveBeenCalledTimes(1); expect(value.stop).not.toHaveBeenCalled();
    expect(controller.snapshot).toMatchObject({ status: "live", controlling: true, wantedControl: true, displayModeBusy: false, hasFrame: false });
    const nextInit = commands.filter(command => command.type === "init").at(-1)!;
    expect(nextInit).toMatchObject({ width: 1280, height: 720 }); expect(nextInit.epoch).not.toBe(oldInit.epoch);
    expect(nextInit.sequenceBase).toBeGreaterThan(oldInit.sequenceBase as number);
    controller.viewerMessage({ type: "framePresented", epoch: oldInit.epoch, attemptId: null, frameId: 1 });
    controller.viewerMessage({ type: "input", epoch: oldInit.epoch, sequence: (oldInit.sequenceBase as number) + 1, events: [{ kind: "release" }] });
    await flushAsync(); expect(value.input).not.toHaveBeenCalled(); expect(controller.snapshot.hasFrame).toBe(false);
    await controller.close();
    expect(value.stop).toHaveBeenCalledWith(value.host, value.lease.leaseId, { lockScreen: false, controlGeneration: 0n });
  });

  it("does not reacquire temporary mode control after a withdrawal while the native write is pending", async () => {
    const value = fixture(true, true, false, true); value.capabilities.resolutionRestore = true;
    let finish!: (result: Awaited<ReturnType<MobileRemoteDesktopTransport["setDisplayMode"]>>) => void;
    value.setDisplayMode.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const controller = new MobileRemoteDesktopController(value.transport); await controller.open(); await flushAsync();
    const pending = controller.setDisplayMode("20"); await flushAsync(); await controller.setControl(false);
    finish(create(RemoteDesktopDisplayModeResultSchema, { lease: { ...value.lease, controlling: false, controlGeneration: 2n } }));
    await pending; expect(controller.snapshot).toMatchObject({ controlling: false, wantedControl: false });
    expect(value.control).not.toHaveBeenCalled(); await controller.close();
  });

  it.each([RemoteDesktopFailureReason.DISPLAY_RESTORE_UNAVAILABLE, undefined])("keeps temporary mode outcome %s for explicit ordinary cleanup without mode replay", async reason => {
    vi.useFakeTimers(); const value = fixture(true, true, false, true); value.capabilities.resolutionRestore = true;
    value.setDisplayMode.mockRejectedValueOnce(reason === undefined ? new Error("Receipt unavailable") : failure(reason));
    const controller = new MobileRemoteDesktopController(value.transport); await controller.open(); await flushAsync();
    await controller.setDisplayMode("20"); await vi.advanceTimersByTimeAsync(8000);
    expect(controller.snapshot).toMatchObject({ status: "error", controlling: false, wantedControl: false, displayModeNotice: reason === undefined ? "change-failed" : "restore-unavailable" });
    expect(value.start).toHaveBeenCalledTimes(1); expect(value.setDisplayMode).toHaveBeenCalledTimes(1);
    value.stop.mockRejectedValueOnce(failure(RemoteDesktopFailureReason.STOPPED));
    value.start.mockResolvedValueOnce(create(RemoteDesktopLeaseSchema, { ...value.lease, leaseId: "fresh-lease", controlling: false, controlGeneration: 2n }));
    await controller.retry(); await flushAsync();
    expect(value.stop).toHaveBeenCalledWith(value.host, value.lease.leaseId, { lockScreen: false, controlGeneration: 0n }, expect.any(AbortSignal));
    expect(value.start).toHaveBeenCalledTimes(2); expect(value.start.mock.calls[1]?.[2]).toBe(RemoteDesktopStartMode.NEW);
    expect(value.setDisplayMode).toHaveBeenCalledTimes(1); expect(controller.snapshot.status).toBe("live"); await controller.close();
  });

  it("rejects replacement geometry and waits through a failed original-mode restore until explicit Retry", async () => {
    vi.useFakeTimers(); const value = fixture(true, true, false, true); value.capabilities.resolutionRestore = true;
    value.setDisplayMode.mockResolvedValueOnce(create(RemoteDesktopDisplayModeResultSchema, { lease: { ...value.lease, leaseId: "replacement", controlGeneration: 2n } }));
    const controller = new MobileRemoteDesktopController(value.transport); await controller.open(); await flushAsync(); await controller.setDisplayMode("20");
    expect(controller.snapshot).toMatchObject({ status: "error", displayModeNotice: "change-failed" });
    value.start.mockRejectedValueOnce(failure(RemoteDesktopFailureReason.DISPLAY_RESTORE_UNAVAILABLE));
    await controller.retry(); expect(controller.snapshot).toMatchObject({ status: "error", displayModeNotice: "restore-unavailable" });
    await vi.advanceTimersByTimeAsync(8000); expect(value.start).toHaveBeenCalledTimes(2);
    await controller.retry(); expect(controller.snapshot.status).toBe("live"); expect(value.setDisplayMode).toHaveBeenCalledTimes(1);
    await controller.close();
  });

  it("keeps the lease for a typed pre-effect display failure but retires and reconnects after success", async () => {
    vi.useFakeTimers();
    const rejected = fixture(true, true, false, true);
    rejected.setDisplayMode.mockRejectedValueOnce(failure(RemoteDesktopFailureReason.DISPLAY_BUSY));
    const first = new MobileRemoteDesktopController(rejected.transport);
    await first.open();
    await flushAsync();
    await first.setDisplayMode("20");
    expect(first.snapshot).toMatchObject({
      status: "live", controlling: true, displayModeBusy: false, displayModeNotice: "change-failed"
    });
    expect(rejected.start).toHaveBeenCalledTimes(1);
    expect(rejected.stop).not.toHaveBeenCalled();
    await first.close();

    const changed = fixture(true, true, false, true);
    const commands: Record<string, unknown>[] = [];
    const second = new MobileRemoteDesktopController(changed.transport);
    second.setViewerSink((command) => commands.push(command as Record<string, unknown>));
    await second.open();
    await flushAsync();
    await second.setDisplayMode("20");
    expect(changed.setDisplayMode).toHaveBeenCalledWith(changed.host, changed.lease.leaseId, 1n,
      "20", false, expect.any(AbortSignal));
    expect(second.snapshot).toMatchObject({ status: "reconnecting", controlling: false, hasFrame: false });
    expect(commands).toContainEqual({ type: "stop", preserveFrame: true });
    expect(changed.stop).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(499);
    expect(changed.start).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(changed.start.mock.calls[1]?.[2]).toBe(RemoteDesktopStartMode.NEW);
    await second.close();
  });

  it("restores control after a display mode reconnect whose NEW lease starts view-only", async () => {
    vi.useFakeTimers();
    const value = fixture(true, true, false, true);
    const replacementLease = create(RemoteDesktopLeaseSchema, {
      leaseId: "lease-2", display: value.lease.display, controlling: false, controlGeneration: 2n
    });
    value.start.mockResolvedValueOnce(value.lease).mockResolvedValueOnce(replacementLease);
    value.control.mockResolvedValueOnce(create(RemoteDesktopControlStateSchema, {
      controlling: true, controlGeneration: 3n
    }));
    const controller = new MobileRemoteDesktopController(value.transport);
    await controller.open();
    await flushAsync();

    await controller.setDisplayMode("20");
    await vi.advanceTimersByTimeAsync(500);

    expect(value.start.mock.calls[1]?.[2]).toBe(RemoteDesktopStartMode.NEW);
    expect(value.control).toHaveBeenCalledWith(value.host, replacementLease.leaseId, true,
      expect.any(AbortSignal));
    expect(controller.snapshot).toMatchObject({ status: "live", controlling: true, wantedControl: true });
    await controller.close();
  });

  it("keeps WebRTC and restores PiP after a typed pre-effect display failure without JPEG polling", async () => {
    vi.useFakeTimers();
    const value = fixture(true, true, true, true);
    value.setDisplayMode.mockRejectedValueOnce(failure(RemoteDesktopFailureReason.DISPLAY_BUSY));
    const commands: Record<string, unknown>[] = [];
    const controller = new MobileRemoteDesktopController(value.transport, undefined, undefined, {
      nativePictureInPicture: true,
      requiresPlaybackSession: false,
      playback: async () => undefined
    });
    controller.setViewerSink((command) => commands.push(command as Record<string, unknown>));
    await controller.open();
    await flushAsync();
    controller.viewerMessage({ type: "ready" });
    const epoch = commands.find((command) => command.type === "init")?.epoch;
    controller.viewerMessage({ type: "iceConfig", epoch, attemptId: "display-mode" });
    controller.viewerMessage({ type: "streaming", epoch, attemptId: "display-mode" });
    controller.viewerMessage({ type: "pipCapability", epoch, supported: true });
    expect(controller.snapshot).toMatchObject({ media: "webrtc", pipAvailable: true });
    const timerCount = vi.getTimerCount();
    value.frame.mockClear();

    await controller.setDisplayMode("20");

    expect(controller.snapshot).toMatchObject({
      status: "live", media: "webrtc", pipAvailable: true, displayModeNotice: "change-failed"
    });
    expect(vi.getTimerCount()).toBe(timerCount);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(value.frame).not.toHaveBeenCalled();
    await controller.close();
  });

  it("retires the old display lease after an outcome-unknown mode mutation", async () => {
    vi.useFakeTimers();
    const value = fixture(true, true, false, true);
    value.setDisplayMode.mockRejectedValueOnce(new Error("response lost"));
    const controller = new MobileRemoteDesktopController(value.transport);
    await controller.open();
    await flushAsync();
    await controller.setDisplayMode("20");
    expect(controller.snapshot).toMatchObject({ status: "reconnecting", displayModeNotice: "change-failed" });
    await vi.advanceTimersByTimeAsync(500);
    expect(value.start.mock.calls[1]?.[2]).toBe(RemoteDesktopStartMode.NEW);
    await controller.close();

    const stopped = fixture(true, true, false, true);
    stopped.setDisplayMode.mockRejectedValueOnce(failure(RemoteDesktopFailureReason.STOPPED));
    const recovering = new MobileRemoteDesktopController(stopped.transport);
    await recovering.open();
    await flushAsync();
    await recovering.setDisplayMode("20");
    expect(recovering.snapshot.status).toBe("reconnecting");
    await vi.advanceTimersByTimeAsync(500);
    expect(stopped.start.mock.calls[1]?.[2]).toBe(RemoteDesktopStartMode.NEW);
    await recovering.close();
  });

  it("retries outcome-unknown mode reconnects through the retired lease TTL without takeover", async () => {
    vi.useFakeTimers();
    const value = fixture(true, true, false, true);
    value.setDisplayMode.mockRejectedValueOnce(new Error("response lost"));
    const controller = new MobileRemoteDesktopController(value.transport);
    await controller.open();
    await flushAsync();
    value.start
      .mockRejectedValueOnce(failure(RemoteDesktopFailureReason.BUSY))
      .mockRejectedValueOnce(failure(RemoteDesktopFailureReason.BUSY))
      .mockRejectedValueOnce(failure(RemoteDesktopFailureReason.BUSY));
    await controller.setDisplayMode("20");

    await vi.advanceTimersByTimeAsync(500 + 1_000 + 3_000);
    expect(controller.snapshot.status).toBe("reconnecting");
    expect(value.start).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(7_999);
    expect(value.start).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(1);
    expect(value.start).toHaveBeenCalledTimes(5);
    expect(value.start.mock.calls.slice(1).every((call) => call[2] === RemoteDesktopStartMode.NEW)).toBe(true);
    expect(controller.snapshot.status).toBe("live");
    await controller.close();
  });

  it("bounds outcome-unknown mode BUSY retries after crossing the retired lease TTL", async () => {
    vi.useFakeTimers();
    const value = fixture(true, true, false, true);
    value.setDisplayMode.mockRejectedValueOnce(new Error("response lost"));
    const controller = new MobileRemoteDesktopController(value.transport);
    await controller.open();
    await flushAsync();
    value.start.mockRejectedValue(failure(RemoteDesktopFailureReason.BUSY));
    await controller.setDisplayMode("20");

    await vi.advanceTimersByTimeAsync(12_500);
    expect(controller.snapshot).toMatchObject({ status: "busy", takeoverAvailable: true, notice: "busy" });
    expect(value.start).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(value.start).toHaveBeenCalledTimes(5);
    await controller.close();
  });

  it("waits for a pending heartbeat before bounding an unknown mode reconnect from its renewed TTL", async () => {
    vi.useFakeTimers();
    const value = fixture(true, true, false, true);
    let resolveHeartbeat!: (state: RemoteDesktopControlState) => void;
    value.heartbeat.mockImplementationOnce(() => new Promise((resolve) => { resolveHeartbeat = resolve; }));
    value.setDisplayMode.mockRejectedValueOnce(new Error("response lost"));
    const controller = new MobileRemoteDesktopController(value.transport);
    await controller.open();
    await flushAsync();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(value.heartbeat).toHaveBeenCalledTimes(1);

    const renewedAt = Date.now() + 2_000;
    value.start.mockImplementation(async () => {
      if (Date.now() < renewedAt + MOBILE_REMOTE_DESKTOP_LEASE_MS) {
        throw failure(RemoteDesktopFailureReason.BUSY);
      }
      return value.lease;
    });
    const change = controller.setDisplayMode("20");
    await flushAsync();
    expect(value.setDisplayMode).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2_000);
    resolveHeartbeat(create(RemoteDesktopControlStateSchema, {
      controlling: true, controlGeneration: 1n
    }));
    await change;
    expect(value.setDisplayMode).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(MOBILE_REMOTE_DESKTOP_LEASE_MS + 499);
    expect(controller.snapshot.status).toBe("reconnecting");
    await vi.advanceTimersByTimeAsync(1);
    expect(controller.snapshot.status).toBe("live");
    expect(value.start.mock.calls.slice(1).every((call) => call[2] === RemoteDesktopStartMode.NEW)).toBe(true);
    await controller.close();
  });

  it("advertises a JPEG-only host without forcing a WebRTC attempt", async () => {
    vi.useFakeTimers();
    const { transport } = fixture(false);
    const controller = new MobileRemoteDesktopController(transport);
    const commands: Record<string, unknown>[] = [];
    controller.setViewerSink((command) => commands.push(command as Record<string, unknown>));
    await controller.open();
    controller.viewerMessage({ type: "ready" });
    expect(commands.find((command) => command.type === "init")).toMatchObject({ webrtc: false });
    expect(remoteDesktopViewerHtml("#111111", "#eeeeee")).toContain("if(message.webrtc===false)");
    await controller.close();
  });

  it("retires the failed heartbeat interval before scheduling a reconnect", async () => {
    vi.useFakeTimers();
    const value = fixture();
    value.heartbeat.mockRejectedValueOnce(new Error("temporary"));
    const controller = new MobileRemoteDesktopController(value.transport);
    await controller.open();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(value.heartbeat).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(value.start).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(value.start.mock.calls[1]?.[2]).toBe(RemoteDesktopStartMode.RESUME);
    expect(value.heartbeat).toHaveBeenCalledTimes(1);
    await controller.close();
  });

  it("reoffers muted Linux audio on the same controlled lease and preserves the desired setting and visible notice", async () => {
    const value = fixture(true, true, true); value.host.platform = "linux"; value.capabilities.platform = "linux"; value.capabilities.cursorOverlay = true;
    value.heartbeat.mockImplementation(async () => create(RemoteDesktopControlStateSchema, { controlling: true, controlGeneration: 1n }));
    value.offer.mockRejectedValueOnce(new ConnectError("System output unavailable", Code.FailedPrecondition, undefined,
      [{ desc: RemoteDesktopFailureSchema, value: create(RemoteDesktopFailureSchema, { reason: RemoteDesktopFailureReason.AUDIO_UNAVAILABLE }) }]));
    const playback = vi.fn(async (_enabled: boolean) => undefined);
    const controller = new MobileRemoteDesktopController(value.transport, undefined, undefined, { nativePictureInPicture: false, requiresPlaybackSession: true, playback });
    const commands: Record<string, unknown>[] = [];
    controller.setViewerSink(command => commands.push(command as Record<string, unknown>));
    await controller.open(); controller.viewerMessage({ type: "ready" });
    const epoch = commands.find(command => command.type === "init")?.epoch;
    controller.viewerMessage({ type: "iceConfig", epoch, attemptId: "linux-audio" });
    controller.viewerMessage({ type: "offer", epoch, attemptId: "linux-audio", sdp: "offer-with-audio" });
    await vi.waitFor(() => expect(commands.filter(command => command.type === "videoSettings")).toEqual([{ type: "videoSettings", audio: false }]));
    expect(value.offer.mock.calls[0]?.[4]).toMatchObject({ audio: true });
    expect(controller.snapshot).toMatchObject({ controlling: true, videoSettingsBusy: true, notice: "audio-unavailable", videoSettings: { audio: true } });
    expect(playback).toHaveBeenCalledWith(false);
    controller.viewerMessage({ type: "iceConfig", epoch, attemptId: "linux-muted" });
    controller.viewerMessage({ type: "offer", epoch, attemptId: "linux-muted", sdp: "new-muted-offer" });
    await vi.waitFor(() => expect(value.offer).toHaveBeenCalledTimes(2)); await flushAsync();
    expect(value.offer.mock.calls[1]?.[1]).toBe(value.lease.leaseId);
    expect(value.offer.mock.calls[1]?.[2]).toBe("linux-muted");
    expect(value.offer.mock.calls[1]?.[4]).toMatchObject({ audio: false });
    controller.viewerMessage({ type: "streaming", epoch, attemptId: "linux-muted" });
    expect(controller.snapshot).toMatchObject({ status: "live", media: "webrtc", hasFrame: true, controlling: true,
      videoSettingsBusy: false, notice: "audio-unavailable", videoSettings: { audio: true } });
    controller.updateVideoSettings({ ...controller.snapshot.videoSettings, audio: false }); await flushAsync();
    controller.viewerMessage({ type: "iceConfig", epoch, attemptId: "audio-off" });
    controller.viewerMessage({ type: "streaming", epoch, attemptId: "audio-off" });
    controller.updateVideoSettings({ ...controller.snapshot.videoSettings, audio: true }); await flushAsync();
    controller.viewerMessage({ type: "iceConfig", epoch, attemptId: "audio-retry" });
    controller.viewerMessage({ type: "offer", epoch, attemptId: "audio-retry", sdp: "new-user-enabled-offer" });
    await vi.waitFor(() => expect(value.offer).toHaveBeenCalledTimes(3));
    expect(value.offer.mock.calls[2]?.[4]).toMatchObject({ audio: true });
    expect(value.start).toHaveBeenCalledTimes(1); expect(value.stop).not.toHaveBeenCalled();
    await controller.close();
  });

  it("ignores a retired Linux audio failure when the viewer has a new media occurrence", async () => {
    const value = fixture(true, false, true); value.host.platform = "linux"; value.capabilities.platform = "linux"; value.capabilities.cursorOverlay = true;
    let fail!: (error: unknown) => void;
    value.offer.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
    const controller = new MobileRemoteDesktopController(value.transport);
    const commands: Record<string, unknown>[] = [];
    controller.setViewerSink(command => commands.push(command as Record<string, unknown>));
    await controller.open(); controller.viewerMessage({ type: "ready" });
    const oldEpoch = commands.find(command => command.type === "init")?.epoch;
    controller.viewerMessage({ type: "iceConfig", epoch: oldEpoch, attemptId: "retired-audio" });
    controller.viewerMessage({ type: "offer", epoch: oldEpoch, attemptId: "retired-audio", sdp: "old-offer" });
    await flushAsync(); controller.viewerProcessLost(); controller.viewerMessage({ type: "ready" });
    const epoch = commands.filter(command => command.type === "init").at(-1)?.epoch;
    expect(epoch).not.toBe(oldEpoch);
    controller.viewerMessage({ type: "iceConfig", epoch, attemptId: "replacement" });
    fail(new ConnectError("Retired audio unavailable", Code.FailedPrecondition, undefined,
      [{ desc: RemoteDesktopFailureSchema, value: create(RemoteDesktopFailureSchema, { reason: RemoteDesktopFailureReason.AUDIO_UNAVAILABLE }) }]));
    await flushAsync();
    expect(commands.filter(command => command.type === "videoSettings")).toHaveLength(0);
    expect(controller.snapshot.videoSettings.audio).toBe(true); expect(controller.snapshot.notice).not.toBe("audio-unavailable");
    expect(value.start).toHaveBeenCalledTimes(1); expect(value.stop).not.toHaveBeenCalled();
    await controller.close();
  });

  it("sends the exact video settings and coalesces rapid edits behind one pending offer", async () => {
    const value = fixture(true, false, true);
    let resolveOffer!: (result: Awaited<ReturnType<MobileRemoteDesktopTransport["offer"]>>) => void;
    value.offer.mockImplementationOnce((_host, _leaseId, attemptId) => new Promise((resolve) => {
      resolveOffer = resolve;
    })).mockImplementation(async (_host, _leaseId, attemptId) => ({
      $typeName: "joko.v1.RemoteDesktopOfferResult" as const, attemptId, answerSdp: "answer"
    }));
    const playback = vi.fn(async (_enabled: boolean) => undefined);
    const controller = new MobileRemoteDesktopController(value.transport, undefined, undefined, {
      nativePictureInPicture: true, requiresPlaybackSession: true, playback
    });
    const commands: Record<string, unknown>[] = [];
    controller.setViewerSink((command) => commands.push(command as Record<string, unknown>));
    await controller.open();
    controller.viewerMessage({ type: "ready" });
    const epoch = commands.find((command) => command.type === "init")?.epoch;
    controller.viewerMessage({ type: "iceConfig", epoch, attemptId: "initial" });
    controller.viewerMessage({ type: "offer", epoch, attemptId: "initial", sdp: "offer-initial" });
    await flushAsync();

    controller.updateVideoSettings({ fps: 60, quality: "saver", audio: true });
    controller.updateVideoSettings({ fps: 60, quality: "hd", audio: false });
    expect(commands.filter((command) => command.type === "videoSettings")).toHaveLength(0);
    resolveOffer({ $typeName: "joko.v1.RemoteDesktopOfferResult", attemptId: "initial", answerSdp: "answer" });
    await vi.waitFor(() => expect(commands.filter((command) => command.type === "videoSettings")).toHaveLength(1));
    expect(commands.filter((command) => command.type === "videoSettings")).toEqual([
      { type: "videoSettings", audio: false }
    ]);
    expect(controller.snapshot.videoSettings).toEqual({ fps: 60, quality: "hd", audio: false });
    controller.viewerMessage({ type: "iceConfig", epoch, attemptId: "latest" });
    controller.viewerMessage({ type: "offer", epoch, attemptId: "latest", sdp: "offer-latest" });
    await flushAsync();
    expect(value.offer.mock.calls.at(-1)?.[4]).toMatchObject({
      fps: 60,
      quality: RemoteDesktopVideoQuality.HD,
      audio: false
    });
    await controller.close();
  });

  it("keeps only an actual system PiP occurrence alive in background and disables it on return", async () => {
    vi.useFakeTimers();
    const value = fixture(true, true, true);
    const playback = vi.fn(async (_enabled: boolean) => undefined);
    const controller = new MobileRemoteDesktopController(value.transport, undefined, undefined, {
      nativePictureInPicture: true, requiresPlaybackSession: true, playback
    });
    const commands: Record<string, unknown>[] = [];
    controller.setViewerSink((command) => commands.push(command as Record<string, unknown>));
    await controller.open();
    controller.viewerMessage({ type: "ready" });
    const epoch = commands.find((command) => command.type === "init")?.epoch;
    controller.viewerMessage({ type: "iceConfig", epoch, attemptId: "pip" });
    controller.viewerMessage({ type: "streaming", epoch, attemptId: "pip" });
    controller.viewerMessage({ type: "pipCapability", epoch, supported: true });
    expect(controller.snapshot.pipAvailable).toBe(true);

    await controller.startPictureInPicture();
    expect(value.presentation).toHaveBeenCalledWith(value.host, value.lease.leaseId, true, expect.any(AbortSignal));
    expect(controller.snapshot.presenting).toBe(false);
    controller.viewerMessage({ type: "presentation", epoch, active: true });
    expect(controller.snapshot.presenting).toBe(true);
    value.stop.mockClear();
    controller.setInteractive(false);
    controller.setForeground(false);
    expect(value.stop).not.toHaveBeenCalled();

    controller.setForeground(true);
    controller.setInteractive(true);
    await vi.waitFor(() => expect(value.presentation).toHaveBeenCalledTimes(2));
    expect(value.presentation).toHaveBeenLastCalledWith(value.host, value.lease.leaseId, false,
      expect.any(AbortSignal));
    expect(controller.snapshot.presenting).toBe(false);
    expect(playback.mock.calls.map(([enabled]) => enabled)).toEqual([true, false, true]);
    await controller.close();
  });

  it("retires a lease when the 4 second PiP rollback response is unknown", async () => {
    vi.useFakeTimers();
    const value = fixture(true, false, true);
    value.presentation.mockResolvedValueOnce(create(RemoteDesktopControlStateSchema, {
      controlling: false, controlGeneration: 2n
    })).mockRejectedValueOnce(new Error("response lost"));
    const controller = new MobileRemoteDesktopController(value.transport, undefined, undefined, {
      nativePictureInPicture: true, requiresPlaybackSession: true, playback: async () => undefined
    });
    const commands: Record<string, unknown>[] = [];
    controller.setViewerSink((command) => commands.push(command as Record<string, unknown>));
    await controller.open();
    controller.viewerMessage({ type: "ready" });
    const epoch = commands.find((command) => command.type === "init")?.epoch;
    controller.viewerMessage({ type: "iceConfig", epoch, attemptId: "pip-timeout" });
    controller.viewerMessage({ type: "streaming", epoch, attemptId: "pip-timeout" });
    controller.viewerMessage({ type: "pipCapability", epoch, supported: true });
    value.stop.mockClear();

    await controller.startPictureInPicture();
    await vi.advanceTimersByTimeAsync(4_000);
    expect(value.presentation.mock.calls.map((call) => call[2])).toEqual([true, false]);
    expect(value.stop).toHaveBeenCalledTimes(1);
    expect(controller.snapshot).toMatchObject({ presenting: false, pipAvailable: false });
    await controller.close();
  });

  it("degrades audio without retiring control when native playback fails before PiP dispatch", async () => {
    const value = fixture(true, true, true);
    const playback = vi.fn(async (enabled: boolean) => {
      if (enabled) throw new Error("audio session unavailable");
    });
    const controller = new MobileRemoteDesktopController(value.transport, undefined, undefined, {
      nativePictureInPicture: true, requiresPlaybackSession: true, playback
    });
    const commands: Record<string, unknown>[] = [];
    controller.setViewerSink((command) => commands.push(command as Record<string, unknown>));
    await controller.open();
    controller.viewerMessage({ type: "ready" });
    const epoch = commands.find((command) => command.type === "init")?.epoch;
    controller.viewerMessage({ type: "iceConfig", epoch, attemptId: "audio-degraded" });
    controller.viewerMessage({ type: "streaming", epoch, attemptId: "audio-degraded" });
    controller.viewerMessage({ type: "pipCapability", epoch, supported: true });
    value.stop.mockClear();

    await controller.startPictureInPicture();
    await vi.waitFor(() => expect(commands.filter((command) => command.type === "videoSettings")).toHaveLength(1));
    expect(value.presentation).not.toHaveBeenCalled();
    expect(value.stop).not.toHaveBeenCalled();
    expect(controller.snapshot).toMatchObject({ controlling: true, notice: "audio-unavailable" });
    expect(commands.filter((command) => command.type === "videoSettings").at(-1))
      .toEqual({ type: "videoSettings", audio: false });
    await controller.close();
  });

  it("transfers one rich item explicitly and never retries an uncertain paste commit", async () => {
    const value = fixture(true, true);
    const phone = clipboardFixture(true);
    const transferId = "123e4567-e89b-12d3-a456-426614174000";
    const desktopJson = JSON.stringify({ text: "desktop text", html: "<b>desktop text</b>" });
    value.clipboardContent.mockImplementation(async (_host, request) => {
      if (request.action.case === "copy") {
        return create(RemoteDesktopClipboardContentResultSchema, {
          transferId, length: desktopJson.length
        });
      }
      if (request.action.case === "read") {
        return create(RemoteDesktopClipboardContentResultSchema, {
          data: desktopJson.slice(request.action.value.offset)
        });
      }
      return create(RemoteDesktopClipboardContentResultSchema, {});
    });
    const controller = new MobileRemoteDesktopController(value.transport, undefined, phone.clipboard);
    await controller.open();
    expect(controller.snapshot).toMatchObject({
      status: "live", controlling: true, clipboardAvailable: true
    });

    await controller.copyToPhone();
    expect(phone.writePortable).toHaveBeenCalledWith(
      { text: "desktop text", html: "<b>desktop text</b>" }, expect.any(Function)
    );
    expect(controller.snapshot).toMatchObject({ clipboardBusy: false, clipboardNotice: "copied" });
    expect(value.clipboardContent.mock.calls.map((call) => call[1].action.case))
      .toEqual(["copy", "read", "cancel"]);
    expect(value.clipboardContent.mock.calls.every((call) => call[1].leaseId === "lease-1"
      && call[1].controlGeneration === 1n)).toBe(true);

    value.clipboardContent.mockClear();
    let commitCalls = 0;
    value.clipboardContent.mockImplementation(async (_host, request) => {
      if (request.action.case === "begin") {
        return create(RemoteDesktopClipboardContentResultSchema, { transferId });
      }
      if (request.action.case === "commit") {
        commitCalls += 1;
        throw new Error("response lost after consume");
      }
      return create(RemoteDesktopClipboardContentResultSchema, {});
    });
    await controller.pasteFromPhone();
    expect(commitCalls).toBe(1);
    expect(value.clipboardContent.mock.calls.map((call) => call[1].action.case))
      .toEqual(["begin", "write", "commit", "cancel"]);
    expect(controller.snapshot).toMatchObject({ clipboardBusy: false, clipboardNotice: "failed" });
    await controller.close();
  });

  it("retires an active transfer on a newer control generation and ignores a late older generation", async () => {
    vi.useFakeTimers();
    const value = fixture(true, true);
    const phone = clipboardFixture(true);
    const transferId = "123e4567-e89b-12d3-a456-426614174001";
    const json = JSON.stringify({ text: "desktop text" });
    let resolveRead!: (result: RemoteDesktopClipboardContentResult) => void;
    value.clipboardContent.mockImplementation(async (_host, request) => {
      if (request.action.case === "copy") {
        return create(RemoteDesktopClipboardContentResultSchema, { transferId, length: json.length });
      }
      if (request.action.case === "read") {
        return new Promise((resolve) => { resolveRead = resolve; });
      }
      return create(RemoteDesktopClipboardContentResultSchema, {});
    });
    let resolveHeartbeat!: (state: RemoteDesktopControlState) => void;
    value.heartbeat.mockImplementationOnce(() => new Promise((resolve) => { resolveHeartbeat = resolve; }));
    const controller = new MobileRemoteDesktopController(value.transport, undefined, phone.clipboard);
    await controller.open();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(value.heartbeat).toHaveBeenCalledTimes(1);

    const transfer = controller.copyToPhone();
    await flushAsync();
    expect(controller.snapshot.clipboardBusy).toBe(true);
    value.control.mockResolvedValueOnce(create(RemoteDesktopControlStateSchema, {
      controlling: true, controlGeneration: 3n
    }));
    await controller.setControl(true);
    expect(controller.snapshot.clipboardBusy).toBe(false);
    resolveRead(create(RemoteDesktopClipboardContentResultSchema, { data: json }));
    await transfer;
    expect(phone.writePortable).not.toHaveBeenCalled();

    resolveHeartbeat(create(RemoteDesktopControlStateSchema, {
      controlling: false, controlGeneration: 2n
    }));
    await flushAsync();
    expect(controller.snapshot.controlling).toBe(true);

    value.clipboardContent.mockClear();
    value.clipboardContent.mockImplementation(async (_host, request) =>
      create(RemoteDesktopClipboardContentResultSchema,
        request.action.case === "begin" ? { transferId } : {}));
    await controller.pasteFromPhone();
    expect(value.clipboardContent.mock.calls.every((call) => call[1].controlGeneration === 3n)).toBe(true);
    expect(controller.snapshot.clipboardNotice).toBe("pasted");
    await controller.close();
  });

  it("refreshes the 60 second idle fence on progress but retires a stalled boundary", async () => {
    vi.useFakeTimers();
    const value = fixture(true, true);
    value.heartbeat.mockResolvedValue(create(RemoteDesktopControlStateSchema, {
      controlling: true, controlGeneration: 1n
    }));
    const phone = clipboardFixture(true);
    const transferId = "123e4567-e89b-12d3-a456-426614174002";
    const json = JSON.stringify({ text: "slow desktop text" });
    const delay = <T,>(result: T): Promise<T> => new Promise((resolve) => {
      setTimeout(() => resolve(result), 40_000);
    });
    value.clipboardContent.mockImplementation(async (_host, request) => {
      if (request.action.case === "copy") {
        return delay(create(RemoteDesktopClipboardContentResultSchema, {
          transferId, length: json.length
        }));
      }
      if (request.action.case === "read") {
        return delay(create(RemoteDesktopClipboardContentResultSchema, { data: json }));
      }
      return create(RemoteDesktopClipboardContentResultSchema, {});
    });
    const controller = new MobileRemoteDesktopController(value.transport, undefined, phone.clipboard);
    await controller.open();

    const progressing = controller.copyToPhone();
    await vi.advanceTimersByTimeAsync(40_000);
    expect(controller.snapshot.clipboardBusy).toBe(true);
    await vi.advanceTimersByTimeAsync(40_000);
    await progressing;
    expect(controller.snapshot).toMatchObject({ clipboardBusy: false, clipboardNotice: "copied" });

    value.clipboardContent.mockImplementation((_host, _request, signal) => new Promise((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(new Error("idle clipboard request retired")), { once: true });
    }));
    const stalled = controller.copyToPhone();
    await vi.advanceTimersByTimeAsync(MOBILE_REMOTE_CLIPBOARD_TRANSFER_MS - 1);
    expect(controller.snapshot.clipboardBusy).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    await stalled;
    expect(controller.snapshot).toMatchObject({ clipboardBusy: false, clipboardNotice: "failed" });
    await controller.close();
  });

  it("keeps a timed-out native effect slot owned until the abort-ignoring write settles", async () => {
    vi.useFakeTimers();
    const value = fixture(true, true);
    value.heartbeat.mockResolvedValue(create(RemoteDesktopControlStateSchema, {
      controlling: true, controlGeneration: 1n
    }));
    const phone = clipboardFixture(true);
    const transferId = "123e4567-e89b-12d3-a456-426614174003";
    const json = JSON.stringify({ text: "desktop text" });
    value.clipboardContent.mockImplementation(async (_host, request) => {
      if (request.action.case === "copy") {
        return create(RemoteDesktopClipboardContentResultSchema, { transferId, length: json.length });
      }
      if (request.action.case === "read") {
        return create(RemoteDesktopClipboardContentResultSchema, { data: json });
      }
      return create(RemoteDesktopClipboardContentResultSchema, {});
    });
    let settleWrite!: () => void;
    phone.writePortable.mockImplementationOnce((_item, check) => {
      check();
      return new Promise<void>((resolve, reject) => {
        settleWrite = () => {
          try { check(); resolve(); } catch (error) { reject(error); }
        };
      });
    });
    const controller = new MobileRemoteDesktopController(value.transport, undefined, phone.clipboard);
    await controller.open();

    const first = controller.copyToPhone();
    await flushAsync();
    expect(phone.writePortable).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(MOBILE_REMOTE_CLIPBOARD_TRANSFER_MS);
    expect(controller.snapshot).toMatchObject({ clipboardBusy: false, clipboardNotice: "failed" });

    await controller.copyToPhone();
    expect(value.clipboardContent.mock.calls.filter((call) => call[1].action.case === "copy")).toHaveLength(1);
    expect(controller.snapshot.clipboardNotice).toBe("busy");

    settleWrite();
    await first;
    await controller.copyToPhone();
    expect(value.clipboardContent.mock.calls.filter((call) => call[1].action.case === "copy")).toHaveLength(2);
    expect(controller.snapshot.clipboardNotice).toBe("copied");
    await controller.close();
  });
});

describe("Remote Desktop boundaries", () => {
  it("admits a Session entry only for its exact DevicePeer Target", () => {
    const session = create(SessionSchema, { sessionId: "session-1", targetId: "target-1" });
    const deviceTarget = create(TargetSchema, { targetId: "target-1", location: create(WorkspaceLocationSchema, {
      kind: { case: "devicePeer", value: create(DevicePeerWorkspaceLocationSchema, {
        controllerDeviceId: "mobile-1", targetDeviceId: "desktop-1", workspaceRootDisplay: "Desktop"
      }) }
    }) });
    const serviceTarget = create(TargetSchema, { targetId: "target-1", location: create(WorkspaceLocationSchema, {
      kind: { case: "serviceNode", value: {} }
    }) });
    expect(mobileRemoteDesktopSessionDeviceId(session, [deviceTarget], "mobile-1")).toBe("desktop-1");
    expect(mobileRemoteDesktopSessionDeviceId(session, [deviceTarget], "mobile-2")).toBeUndefined();
    expect(mobileRemoteDesktopSessionDeviceId(session, [deviceTarget], undefined)).toBeUndefined();
    expect(mobileRemoteDesktopSessionDeviceId(session, [serviceTarget], "mobile-1")).toBeUndefined();
    expect(mobileRemoteDesktopSessionDeviceId(session, [deviceTarget, deviceTarget], "mobile-1")).toBeUndefined();
  });

  it("accepts a zero relation revision while retaining the exact route fence", () => {
    const { route } = fixture();
    expect(mobileRemoteDesktopNetworkTesting.remoteDesktopPeerKey(route)).toContain("relation-1");
  });

  it("keeps credentialless STUN beside a short-lived credentialled TURN server", () => {
    const now = Date.now();
    const stun = create(RemoteDesktopIceServerSchema, { urls: ["stun:stun.example.test:3478"] });
    const turn = create(RemoteDesktopIceServerSchema, {
      urls: ["turn:turn.example.test:3478?transport=udp"], username: "short-user", credential: "short-secret",
      expiresAt: create(TimestampSchema, { seconds: BigInt(Math.floor((now + 600_000) / 1_000)) })
    });
    expect(mobileRemoteDesktopTesting.validIceServers([stun, turn], now)).toEqual([
      { urls: ["stun:stun.example.test:3478"] },
      { urls: ["turn:turn.example.test:3478?transport=udp"], username: "short-user", credential: "short-secret" }
    ]);
  });

  it("admits host cursor capability while preserving platform mode and restore boundaries", () => {
    const { capabilities } = fixture(true, true, false, true);
    expect(mobileRemoteDesktopTesting.validCapabilities(capabilities)).toBe(true);
    expect(mobileRemoteDesktopTesting.validCapabilities(create(RemoteDesktopCapabilitiesSchema, {
      ...capabilities, platform: "win32", displayModes: false, cursorOverlay: false, lockOnExit: false
    }))).toBe(true);
    expect(mobileRemoteDesktopTesting.validCapabilities(create(RemoteDesktopCapabilitiesSchema, {
      ...capabilities, platform: "win32"
    }))).toBe(false);
    expect(mobileRemoteDesktopTesting.validCapabilities(create(RemoteDesktopCapabilitiesSchema, {
      ...capabilities, platform: "win32", displayModes: false, cursorOverlay: true, lockOnExit: false
    }))).toBe(true);
    expect(mobileRemoteDesktopTesting.validCapabilities(create(RemoteDesktopCapabilitiesSchema, {
      ...capabilities, platform: "linux", displayModes: false, cursorOverlay: true
    }))).toBe(true);
    expect(mobileRemoteDesktopTesting.validCapabilities(create(RemoteDesktopCapabilitiesSchema, {
      ...capabilities, platform: "linux", displayModes: true, cursorOverlay: true, resolutionRestore: true
    }))).toBe(true);
    expect(mobileRemoteDesktopTesting.validCapabilities(create(RemoteDesktopCapabilitiesSchema, {
      ...capabilities, platform: "linux", viewerDisplay: true, viewerDisplayRestore: true
    }))).toBe(true);
    expect(mobileRemoteDesktopTesting.validCapabilities(create(RemoteDesktopCapabilitiesSchema, {
      ...capabilities, platform: "linux", viewerDisplayRestore: true
    }))).toBe(false);
    expect(mobileRemoteDesktopTesting.validCapabilities(create(RemoteDesktopCapabilitiesSchema, {
      ...capabilities, platform: "darwin", viewerDisplay: true, viewerDisplayRestore: true
    }))).toBe(true);
    expect(mobileRemoteDesktopTesting.validCapabilities(create(RemoteDesktopCapabilitiesSchema, {
      ...capabilities, platform: "win32", displayModes: false, lockOnExit: false, viewerDisplay: true, viewerDisplayRestore: true
    }))).toBe(false);
    expect(mobileRemoteDesktopTesting.validCapabilities(create(RemoteDesktopCapabilitiesSchema, {
      ...capabilities, platform: "linux", displayModes: false, resolutionRestore: true
    }))).toBe(false);
    expect(mobileRemoteDesktopTesting.validCapabilities(create(RemoteDesktopCapabilitiesSchema, {
      ...capabilities, platform: "win32", displayModes: false, cursorOverlay: false, resolutionRestore: true
    }))).toBe(false);
    expect(mobileRemoteDesktopTesting.validCapabilities(create(RemoteDesktopCapabilitiesSchema, {
      ...capabilities, platform: "freebsd", displayModes: false, cursorOverlay: false
    }))).toBe(false);
    expect(mobileRemoteDesktopTesting.validCapabilities(create(RemoteDesktopCapabilitiesSchema, {
      ...capabilities, platform: "win32", displayModes: false, cursorOverlay: false, lockOnExit: true
    }))).toBe(false);
    expect(mobileRemoteDesktopTesting.validCapabilities(create(RemoteDesktopCapabilitiesSchema, {
      ...capabilities, platform: "linux", lockOnExit: true, hostMute: false, privacyScreen: false, nativeCredentials: false
    }))).toBe(true);
    expect(mobileRemoteDesktopTesting.validCapabilities({ ...capabilities, lockOnExit: 1 as unknown as boolean })).toBe(false);
    expect(mobileRemoteDesktopTesting.validCapabilities(create(RemoteDesktopCapabilitiesSchema, {
      ...capabilities, platform: "linux", workspaceNavigation: true, systemMenu: true
    }))).toBe(true);
    for (const platform of ["darwin", "win32"]) {
      expect(mobileRemoteDesktopTesting.validCapabilities(create(RemoteDesktopCapabilitiesSchema, {
        ...capabilities, platform, displayModes: false, lockOnExit: false, workspaceNavigation: true
      }))).toBe(false);
      expect(mobileRemoteDesktopTesting.validCapabilities(create(RemoteDesktopCapabilitiesSchema, {
        ...capabilities, platform, displayModes: false, lockOnExit: false, systemMenu: true
      }))).toBe(false);
    }
    expect(mobileRemoteDesktopTesting.validCapabilities({ ...capabilities, workspaceNavigation: undefined as unknown as boolean })).toBe(false);
    expect(mobileRemoteDesktopTesting.validCapabilities({ ...capabilities, systemMenu: 1 as unknown as boolean })).toBe(false);
  });

  it("bounds fitted viewer dimensions to an even 1920 long edge and a usable short edge", () => {
    expect(mobileRemoteDesktopTesting.viewerDisplaySize(390, 844)).toEqual({ width: 888, height: 1920 });
    expect(mobileRemoteDesktopTesting.viewerDisplaySize(1920, 1080)).toEqual({ width: 1920, height: 1080 });
    expect(mobileRemoteDesktopTesting.viewerDisplaySize(2000, 100)).toBeUndefined();
    expect(mobileRemoteDesktopTesting.viewerDisplaySize(Number.NaN, 500)).toBeUndefined();
    expect(mobileRemoteDesktopTesting.viewerDisplaySize(Number.MIN_VALUE, Number.MIN_VALUE)).toBeUndefined();
  });

  it("bounds cursor PNG geometry and display mode identity at both mobile trust boundaries", () => {
    const cursor = create(RemoteDesktopCursorSchema, {
      visible: true, x: 0.5, y: 0.5, width: 32, height: 32, hotX: 1, hotY: 2, png: cursorPng(64, 64)
    });
    expect(mobileRemoteDesktopNetworkTesting.validRemoteDesktopCursor(cursor)).toBe(true);
    expect(mobileRemoteDesktopTesting.validRemoteDesktopCursor(cursor)).toBe(true);
    const truncatedIhdr = create(RemoteDesktopCursorSchema, { ...cursor, png: cursor.png.slice(0, 32) });
    expect(mobileRemoteDesktopNetworkTesting.validRemoteDesktopCursor(truncatedIhdr)).toBe(false);
    expect(mobileRemoteDesktopTesting.validRemoteDesktopCursor(truncatedIhdr)).toBe(false);
    const oversizedRaster = create(RemoteDesktopCursorSchema, { ...cursor, png: cursorPng(513, 32) });
    expect(mobileRemoteDesktopNetworkTesting.validRemoteDesktopCursor(oversizedRaster)).toBe(false);
    expect(mobileRemoteDesktopTesting.validRemoteDesktopCursor(oversizedRaster)).toBe(false);
    const modes = [create(RemoteDesktopDisplayModeSchema, {
      modeId: "7", width: 1920, height: 1080, current: true, native: true
    })];
    expect(mobileRemoteDesktopNetworkTesting.validRemoteDesktopDisplayModes(modes)).toBe(true);
    expect(mobileRemoteDesktopTesting.validDisplayModes(modes)).toBe(true);
    expect(mobileRemoteDesktopTesting.validDisplayModes([
      modes[0]!, create(RemoteDesktopDisplayModeSchema, { ...modes[0], current: false })
    ])).toBe(false);
  });

  it("requires viewer epochs and bounds input while retaining ordered WebRTC and JPEG fallback", () => {
    expect(mobileRemoteDesktopTesting.parseViewerMessage({ type: "streaming" })).toBeUndefined();
    expect(mobileRemoteDesktopTesting.parseViewerMessage({ type: "streaming", epoch: "lease-1" })).toBeUndefined();
    expect(mobileRemoteDesktopTesting.parseViewerMessage({ type: "streaming", epoch: "lease-1", attemptId: "1" }))
      .toEqual({ type: "streaming", epoch: "lease-1", attemptId: "1" });
    expect(mobileRemoteDesktopTesting.parseViewerMessage({
      type: "framePresented", epoch: "lease-1", frameId: "frame-1", presented: true
    })).toEqual({ type: "framePresented", epoch: "lease-1", frameId: "frame-1", presented: true });
    expect(mobileRemoteDesktopTesting.parseInputEvents([{ kind: "release" }])).toHaveLength(1);
    const html = remoteDesktopViewerHtml("#111111", "#eeeeee");
    expect(html).toContain("createDataChannel('input-v1',{ordered:true})");
    expect(html).toContain("message.sequenceBase");
    expect(html).toContain("type:'framePresented',frameId,presented:!nativeVideoActive");
    expect(html).toContain("if(videoPresented)post({type:'streaming',attemptId})");
    expect(html).toContain("post({type:'iceConfig',attemptId});if(!window.RTCPeerConnection)");
    expect(html).toContain("image.src='data:image/jpeg;base64,'");
    expect(html).toContain("addTransceiver('audio',{direction:'recvonly'})");
    expect(html).toContain("presentationActive()&&message.type==='viewPing'");
    expect(html).toContain("dc.send(message.challenge)");
    expect(html).toContain("message.type==='cursor'");
    expect(html).toContain("keys.length===8");
    expect(html).toContain("width>=1&&width<=512&&height>=1&&height<=512");
    expect(html).toContain("!cursorOverlay&&control&&(mode==='trackpad'||nativeTouchpad!==null||localCursorAwake)");
    expect(html).toContain("performance.now()-lastLocalMove>200");
    expect(html).toContain("token!==localCursorGeneration||epoch!==cursorEpoch");
    expect(html).toContain("localCursorTimer=setTimeout");
    expect(html).toContain("if(remoteCursor){cx=remoteCursor.x;cy=remoteCursor.y;}");
    expect(html).not.toContain("!remoteCursor||!control||mode!=='trackpad'");
    expect(mobileRemoteDesktopViewerTesting.RTC_NETWORK.retryMs).toEqual([1_000, 3_000, 8_000]);
  });

  it("uses the same trackpad mode name in native and viewer commands", async () => {
    const value = fixture();
    const commands: Record<string, unknown>[] = [];
    const controller = new MobileRemoteDesktopController(value.transport);
    controller.setViewerSink((command) => commands.push(command as Record<string, unknown>));
    await controller.open();
    controller.viewerMessage({ type: "ready" });
    controller.setInputMode("trackpad");
    expect(commands.at(-1)).toEqual({ type: "mode", mode: "trackpad" });
    expect(remoteDesktopViewerHtml("#111111", "#eeeeee")).toContain("mode==='trackpad'");
    await controller.close();
  });

  it("maps typed notices through every supported language without exposing server text", () => {
    for (const locale of ["en", "zh-CN", "zh-TW", "ja", "ko"] as const) {
      const copy = mobileRemoteDesktopCopy(locale);
      expect(mobileRemoteDesktopNoticeLabel("viewer-restarted", copy)).toBe(copy.viewerRestarted);
      expect(mobileRemoteDesktopNoticeLabel("audio-unavailable", copy)).toBe(copy.audioUnavailable);
      expect(mobileRemoteDesktopNoticeLabel("video-settings-failed", copy)).toBe(copy.videoSettingsFailed);
      expect(mobileRemoteDesktopNoticeLabel("pip-unavailable", copy)).toBe(copy.pipUnavailable);
      expect(mobileRemoteDesktopNoticeLabel("generic-error", copy)).toBe(copy.error);
      expect(mobileRemoteDesktopClipboardNoticeLabel("copied", copy)).toBe(copy.clipboardCopied);
      expect(mobileRemoteDesktopClipboardNoticeLabel("too-large", copy)).toBe(copy.clipboardTooLarge);
    }
  });
});
