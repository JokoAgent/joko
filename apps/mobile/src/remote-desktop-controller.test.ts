import { create } from "@bufbuild/protobuf";
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
  RemoteDesktopControlStateSchema,
  RemoteDesktopCursorSchema,
  RemoteDesktopDisplayModeSchema,
  RemoteDesktopDisplaySchema,
  RemoteDesktopFailureReason,
  RemoteDesktopFailureSchema,
  RemoteDesktopFrameSchema,
  RemoteDesktopFrameResultSchema,
  RemoteDesktopIceServerSchema,
  RemoteDesktopLeaseSchema,
  RemoteDesktopPermissionStatus,
  RemoteDesktopPermissionsSchema,
  RemoteDesktopStartMode,
  RemoteDesktopVideoQuality,
  RevisionSchema,
  SessionSchema,
  TargetSchema,
  WorkspaceLocationSchema,
  type RemoteDesktopClipboardContentResult,
  type RemoteDesktopControlState
} from "@joko/contracts";
import { mobileRemoteDesktopNetworkTesting } from "./network";
import {
  MOBILE_REMOTE_DESKTOP_LEASE_MS,
  MobileRemoteDesktopController,
  mobileRemoteDesktopTesting,
  type MobileRemoteDesktopTransport
} from "./remote-desktop-controller";
import { mobileRemoteDesktopViewerTesting, remoteDesktopViewerHtml } from "./remote-desktop-viewer";
import {
  mobileRemoteDesktopCopy,
  mobileRemoteDesktopClipboardNoticeLabel,
  mobileRemoteDesktopNoticeLabel,
  mobileRemoteDesktopSessionDeviceId
} from "./remote-desktop-presentation";
import {
  MOBILE_REMOTE_CLIPBOARD_TRANSFER_MS,
  type MobileRemoteClipboardSystem
} from "./mobile-remote-desktop-clipboard";

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
    displayModes: rd01Features, cursorOverlay: rd01Features
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
  const setDisplayMode = vi.fn<MobileRemoteDesktopTransport["setDisplayMode"]>(async () => undefined);
  const clipboardText = vi.fn<MobileRemoteDesktopTransport["clipboardText"]>(async () =>
    create(RemoteDesktopClipboardTextResultSchema, {}));
  const clipboardContent = vi.fn<MobileRemoteDesktopTransport["clipboardContent"]>(async () =>
    create(RemoteDesktopClipboardContentResultSchema, {}));
  const transport: MobileRemoteDesktopTransport = {
    ownerKey: "owner-1", isCurrent: () => true, canStop: () => true,
    listHosts: vi.fn(async () => [host]), capabilities: vi.fn(async () => capabilities),
    permissions: vi.fn(async () => permissions), showPermissionGuide: vi.fn(async () => permissions),
    start, heartbeat, stop, control, presentation, input, iceConfiguration: vi.fn(async () => []),
    offer, ice: vi.fn(async (_host, _leaseId, attemptId, candidates, after) => ({
      $typeName: "joko.v1.RemoteDesktopIceExchangeResult" as const,
      attemptId, candidates: [...candidates], next: after + candidates.length, complete: true
    })), frame, listDisplayModes, setDisplayMode, clipboardText, clipboardContent
  };
  return { route, host, capabilities, transport, start, heartbeat, stop, control, presentation, input, offer, frame,
    listDisplayModes, setDisplayMode, clipboardText, clipboardContent, lease };
}

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
    richAvailable, readPortable, writePortable, readLegacyText, writeLegacyText
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
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function cursorPng(width = 32, height = 32): Uint8Array {
  return Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
    (width >>> 24) & 0xff, (width >>> 16) & 0xff, (width >>> 8) & 0xff, width & 0xff,
    (height >>> 24) & 0xff, (height >>> 16) & 0xff, (height >>> 8) & 0xff, height & 0xff,
    8, 6, 0, 0, 0, 0, 0, 0, 0
  ]);
}

describe("MobileRemoteDesktopController", () => {
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
      "20", expect.any(AbortSignal));
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

  it("admits RD-01 capabilities only on a known macOS host", () => {
    const { capabilities } = fixture(true, true, false, true);
    expect(mobileRemoteDesktopTesting.validCapabilities(capabilities)).toBe(true);
    expect(mobileRemoteDesktopTesting.validCapabilities(create(RemoteDesktopCapabilitiesSchema, {
      ...capabilities, platform: "win32", displayModes: false, cursorOverlay: false
    }))).toBe(true);
    expect(mobileRemoteDesktopTesting.validCapabilities(create(RemoteDesktopCapabilitiesSchema, {
      ...capabilities, platform: "win32"
    }))).toBe(false);
    expect(mobileRemoteDesktopTesting.validCapabilities(create(RemoteDesktopCapabilitiesSchema, {
      ...capabilities, platform: "freebsd", displayModes: false, cursorOverlay: false
    }))).toBe(false);
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
    expect(html).toContain("type:'framePresented',frameId,presented:true");
    expect(html).toContain("if(videoPresented)post({type:'streaming',attemptId})");
    expect(html).toContain("post({type:'iceConfig',attemptId});if(!window.RTCPeerConnection)");
    expect(html).toContain("image.src='data:image/jpeg;base64,'");
    expect(html).toContain("addTransceiver('audio',{direction:'recvonly'})");
    expect(html).toContain("presentationActive()&&message.type==='viewPing'");
    expect(html).toContain("dc.send(message.challenge)");
    expect(html).toContain("message.type==='cursor'");
    expect(html).toContain("keys.length===8");
    expect(html).toContain("width>=1&&width<=512&&height>=1&&height<=512");
    expect(html).toContain("!cursorOverlay&&control&&mode==='trackpad'");
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
