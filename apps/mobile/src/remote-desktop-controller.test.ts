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
  RevisionSchema,
  SessionSchema,
  TargetSchema,
  WorkspaceLocationSchema
} from "@joko/contracts";
import { mobileRemoteDesktopNetworkTesting } from "./network";
import {
  MobileRemoteDesktopController,
  mobileRemoteDesktopTesting,
  type MobileRemoteDesktopTransport
} from "./remote-desktop-controller";
import { mobileRemoteDesktopViewerTesting, remoteDesktopViewerHtml } from "./remote-desktop-viewer";
import {
  mobileRemoteDesktopCopy,
  mobileRemoteDesktopNoticeLabel,
  mobileRemoteDesktopSessionDeviceId
} from "./remote-desktop-presentation";

afterEach(() => {
  vi.useRealTimers();
});

function fixture(webrtcVideo = true, controlling = false) {
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
    automaticReconnect: true, connectionTakeover: true, webrtcVideo, trickleIce: true, jpegFallback: true
  });
  const lease = create(RemoteDesktopLeaseSchema, { leaseId: "lease-1", display, controlling });
  const start = vi.fn<MobileRemoteDesktopTransport["start"]>(async () => lease);
  const heartbeat = vi.fn<MobileRemoteDesktopTransport["heartbeat"]>(async () => ({
    $typeName: "joko.v1.RemoteDesktopControlState" as const, controlling: false
  }));
  const stop = vi.fn<MobileRemoteDesktopTransport["stop"]>(async () => undefined);
  const control = vi.fn<MobileRemoteDesktopTransport["control"]>(async (_host, _leaseId, enabled) => ({
    $typeName: "joko.v1.RemoteDesktopControlState" as const, controlling: enabled
  }));
  const input = vi.fn<MobileRemoteDesktopTransport["input"]>(async () => undefined);
  const offer = vi.fn<MobileRemoteDesktopTransport["offer"]>(async (_host, _leaseId, attemptId) => ({
    $typeName: "joko.v1.RemoteDesktopOfferResult" as const, attemptId, answerSdp: "answer"
  }));
  const frame = vi.fn<MobileRemoteDesktopTransport["frame"]>(async () => create(RemoteDesktopFrameResultSchema, {}));
  const transport: MobileRemoteDesktopTransport = {
    ownerKey: "owner-1", isCurrent: () => true, canStop: () => true,
    listHosts: vi.fn(async () => [host]), capabilities: vi.fn(async () => capabilities),
    permissions: vi.fn(async () => permissions), showPermissionGuide: vi.fn(async () => permissions),
    start, heartbeat, stop, control, input, iceConfiguration: vi.fn(async () => []),
    offer, ice: vi.fn(async (_host, _leaseId, attemptId, candidates, after) => ({
      $typeName: "joko.v1.RemoteDesktopIceExchangeResult" as const,
      attemptId, candidates: [...candidates], next: after + candidates.length, complete: true
    })), frame
  };
  return { route, host, transport, start, heartbeat, stop, control, input, offer, frame, lease };
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
      "current", "current-offer", expect.any(AbortSignal));
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
    expect(html).not.toContain("addTransceiver('audio'");
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
      expect(mobileRemoteDesktopNoticeLabel("generic-error", copy)).toBe(copy.error);
    }
  });
});
