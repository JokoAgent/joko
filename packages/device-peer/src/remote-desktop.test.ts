import { describe, expect, it, vi } from "vitest";

import {
  REMOTE_DESKTOP_FRAME_INTERVAL_MS,
  REMOTE_DESKTOP_LEASE_MS,
  REMOTE_DESKTOP_MAX_CURSOR_RASTER_DIMENSION,
  REMOTE_DESKTOP_MAX_FRAME_BYTES,
  isBoundedRemoteDesktopJpegFrame,
  isRemoteDesktopCursor,
  isRemoteDesktopInput,
  parseRemoteDesktopClipboardContentJson,
  parseRemoteDesktopHostCapabilities,
  parseRemoteDesktopDisplayModes,
  parseRemoteDesktopRequest,
  parseRemoteDesktopVideoSettings,
  stringifyRemoteDesktopClipboardContent,
  type RemoteDesktopHostCapabilities,
  type RemoteDesktopLease
} from "./remote-desktop.js";
import {
  RemoteDesktopController,
  type RemoteDesktopAuthority,
  type RemoteDesktopControllerDependencies
} from "./remote-desktop-controller.js";
import {
  parseRemoteDesktopIceCandidates,
  parseRemoteDesktopIceReply
} from "./remote-desktop-ice.js";
import {
  parseRemoteDesktopIceConfig,
  resolveRemoteDesktopIceServers
} from "./remote-desktop-ice-config.js";

const LIFECYCLE_TOKEN = Object.freeze({});
const RETIRED_LIFECYCLE_TOKEN = Object.freeze({});

const AUTHORITY: RemoteDesktopAuthority = Object.freeze({
  controllerDeviceId: "controller-a",
  lifecycleToken: LIFECYCLE_TOKEN
});

const OTHER_AUTHORITY: RemoteDesktopAuthority = Object.freeze({
  controllerDeviceId: "controller-b",
  lifecycleToken: LIFECYCLE_TOKEN
});

const CAPABILITIES: RemoteDesktopHostCapabilities = Object.freeze({
  version: 1,
  enabled: true,
  canControl: true,
  platform: "darwin",
  displays: Object.freeze([
    Object.freeze({ id: "display-1", name: "Built-in Display", width: 1_280, height: 800 })
  ]),
  permissions: Object.freeze({ screenRecording: "granted", accessibility: "granted" }),
  clipboardText: true,
  clipboardContent: true,
  videoSettings: true,
  systemAudio: true,
  backgroundViewing: true,
  displayModes: true,
  cursorOverlay: true,
  hostMute: true,
  lockOnExit: true,
  clipboardSync: true,
  clipboardInline: true,
  privacyScreen: true,
  nativeCredentials: true,
  resolutionRestore: true,
  viewerDisplay: false,
  viewerDisplayRestore: false,
  workspaceNavigation: false,
  systemMenu: false
});

describe("remote desktop portable protocol", () => {
  it("native authentication keeps ordinary paired viewing and control available", async () => {
    const fixture = controllerFixture();
    fixture.dependencies.authenticationSession = vi.fn(() => null);
    const lease = await start(fixture);
    await fixture.controller.request(AUTHORITY, { op: "control", lease: lease.lease, enabled: true });
    expect(fixture.controller.state?.controlling).toBe(true);
    expect(fixture.dependencies.authenticationSession).not.toHaveBeenCalled();
  });

  it("native authentication rejects retired occurrences before metadata or start effects", async () => {
    const fixture = controllerFixture();
    fixture.dependencies.authenticationSession = () => null;
    const authority = { ...AUTHORITY, authenticationOwner: {} };
    await expect(fixture.controller.request(authority, { op: "capabilities" })).rejects.toThrow("REMOTE_DESKTOP_AUTHENTICATION_REQUIRED");
    await expect(fixture.controller.request(authority, { op: "start", displayId: "display-1" })).rejects.toThrow("REMOTE_DESKTOP_AUTHENTICATION_REQUIRED");
    expect(fixture.dependencies.capabilities).not.toHaveBeenCalled();
  });

  it("native authentication replacement retires only its captured lease", async () => {
    const fixture = controllerFixture();
    let proof: string | null = "session-a";
    fixture.dependencies.authenticationSession = () => proof;
    const authority = { ...AUTHORITY, authenticationOwner: {} };
    await fixture.controller.request(authority, { op: "start", displayId: "display-1" });
    proof = "session-b";
    fixture.controller.tick();
    expect(fixture.controller.state).toBeUndefined();
    const ordinary = await start(fixture);
    proof = null;
    fixture.controller.tick();
    expect(fixture.controller.state?.lease).toBe(ordinary.lease);
  });

  it("native authentication fences a late start when its proof changes", async () => {
    const fixture = controllerFixture();
    let proof = "session-a";
    fixture.dependencies.authenticationSession = () => proof;
    let ready!: (value: RemoteDesktopHostCapabilities) => void;
    vi.mocked(fixture.dependencies.capabilities).mockReturnValueOnce(new Promise(resolve => { ready = resolve; }));
    const starting = expect(fixture.controller.request({ ...AUTHORITY, authenticationOwner: {} }, {
      op: "start", displayId: "display-1"
    })).rejects.toThrow("REMOTE_DESKTOP_AUTHENTICATION_REQUIRED");
    proof = "session-b"; ready(CAPABILITIES); await starting;
    expect(fixture.controller.state).toBeUndefined();
    expect(fixture.dependencies.startInput).not.toHaveBeenCalled();
  });

  it("native authentication drops a late frame and releases the captured input", async () => {
    const fixture = controllerFixture();
    let proof: string | null = "session-a";
    fixture.dependencies.authenticationSession = () => proof;
    const authority = { ...AUTHORITY, authenticationOwner: {} };
    const lease = await fixture.controller.request(authority, { op: "start", displayId: "display-1" }) as RemoteDesktopLease;
    await fixture.controller.request(authority, { op: "control", lease: lease.lease, enabled: true });
    let ready!: () => void;
    vi.mocked(fixture.dependencies.frame).mockImplementationOnce(async () => {
      await new Promise<void>(resolve => { ready = resolve; });
      return { jpeg: "YWJj", width: 3, height: 1 };
    });
    const frame = expect(fixture.controller.request(AUTHORITY, { op: "frame", lease: lease.lease, cursorOverlay: false }))
      .rejects.toThrow("REMOTE_DESKTOP_AUTHENTICATION_REQUIRED");
    await vi.waitFor(() => expect(ready).toBeDefined()); proof = null; ready(); await frame;
    expect(fixture.controller.state).toBeUndefined();
    expect(fixture.dependencies.stopInput).toHaveBeenCalled();
    expect(fixture.dependencies.stopVideo).toHaveBeenCalled();
  });

  it("native authentication retirement blocks direct input and presentation pong renewal", async () => {
    const fixture = controllerFixture();
    let proof: string | null = "session-a";
    fixture.dependencies.authenticationSession = () => proof;
    const authority = { ...AUTHORITY, authenticationOwner: {} };
    const lease = await fixture.controller.request(authority, { op: "start", displayId: "display-1" }) as RemoteDesktopLease;
    await fixture.controller.request(authority, { op: "control", lease: lease.lease, enabled: true });
    proof = null;
    expect(() => fixture.controller.input(AUTHORITY, lease.lease, 1, [{ kind: "release" }]))
      .toThrow("REMOTE_DESKTOP_AUTHENTICATION_REQUIRED");
    expect(fixture.dependencies.input).not.toHaveBeenCalled();
    proof = "session-b";
    const next = await fixture.controller.request(authority, { op: "start", displayId: "display-1" }) as RemoteDesktopLease;
    await fixture.controller.request(authority, { op: "presentation", lease: next.lease, enabled: true });
    proof = null; fixture.controller.recordPresentationPong(next.lease);
    expect(fixture.controller.state).toBeUndefined();
  });
  it("accepts only bounded current-v1 input and request shapes", () => {
    expect(isRemoteDesktopInput({ kind: "move", x: 0.25, y: 0.75 })).toBe(true);
    expect(isRemoteDesktopInput({ kind: "move", x: 0.25, y: 0.75, legacy: true })).toBe(false);
    expect(isRemoteDesktopInput({ kind: "key", code: "KeyJ", down: true })).toBe(true);
    expect(isRemoteDesktopInput({ kind: "key", code: "VolumeUp", down: true })).toBe(false);

    expect(parseRemoteDesktopRequest({ op: "start", displayId: "display-1", takeover: true }))
      .toEqual({ op: "start", displayId: "display-1", takeover: true });
    expect(() => parseRemoteDesktopRequest({
      op: "start", displayId: "display-1", takeover: true, resume: true
    })).toThrowError("INVALID_REMOTE_DESKTOP_REQUEST");
    expect(() => parseRemoteDesktopRequest({ op: "clipboard", lease: "lease-1" }))
      .toThrowError("INVALID_REMOTE_DESKTOP_REQUEST");
    expect(() => parseRemoteDesktopRequest({ op: "offer", lease: "lease-1", sdp: "offer" }))
      .toThrowError("INVALID_REMOTE_DESKTOP_REQUEST");
    expect(parseRemoteDesktopRequest({
      op: "offer",
      lease: "lease-1",
      sdp: "offer",
      attemptId: "attempt-1",
      cursorOverlay: false
    })).toEqual({
      op: "offer",
      lease: "lease-1",
      sdp: "offer",
      attemptId: "attempt-1",
      cursorOverlay: false
    });
    expect(() => parseRemoteDesktopRequest({
      op: "offer", lease: "lease-1", sdp: "offer", attemptId: "attempt-1"
    })).toThrowError("INVALID_REMOTE_DESKTOP_REQUEST");
    expect(parseRemoteDesktopRequest({
      op: "frame", lease: "lease-1", cursorOverlay: false
    })).toEqual({ op: "frame", lease: "lease-1", cursorOverlay: false });
    expect(() => parseRemoteDesktopRequest({ op: "frame", lease: "lease-1" }))
      .toThrowError("INVALID_REMOTE_DESKTOP_REQUEST");
    expect(parseRemoteDesktopVideoSettings({ fps: 60, quality: "hd", audio: true }))
      .toEqual({ fps: 60, quality: "hd", audio: true });
    expect(() => parseRemoteDesktopVideoSettings({ fps: 24, quality: "hd", audio: true }))
      .toThrowError("INVALID_REMOTE_DESKTOP_VIDEO_SETTINGS");
    expect(() => parseRemoteDesktopVideoSettings({ fps: 60, quality: "ultra", audio: true }))
      .toThrowError("INVALID_REMOTE_DESKTOP_VIDEO_SETTINGS");
    expect(() => parseRemoteDesktopRequest({
      op: "input",
      lease: "lease-1",
      sequence: 1,
      events: [{ kind: "scroll", dx: 0, dy: 2_001 }]
    })).toThrowError("INVALID_REMOTE_DESKTOP_REQUEST");
    expect(() => parseRemoteDesktopRequest({
      op: "input", lease: "lease-1", sequence: 0, events: [{ kind: "release" }]
    })).toThrowError("INVALID_REMOTE_DESKTOP_REQUEST");
    expect(() => parseRemoteDesktopRequest({
      op: "input", lease: "lease-1", sequence: 1, events: []
    })).toThrowError("INVALID_REMOTE_DESKTOP_REQUEST");
    expect(parseRemoteDesktopRequest({
      op: "resolution", lease: "lease-1", controlGeneration: 2, modeId: "101", temporary: false
    })).toEqual({
      op: "resolution", lease: "lease-1", controlGeneration: 2, modeId: "101", temporary: false
    });
    expect(() => parseRemoteDesktopRequest({
      op: "resolution", lease: "lease-1", controlGeneration: 0, modeId: "101", temporary: false
    })).toThrowError("INVALID_REMOTE_DESKTOP_REQUEST");
    expect(parseRemoteDesktopRequest({
      op: "hostMute", lease: "lease-1", controlGeneration: 2, enabled: true
    })).toEqual({ op: "hostMute", lease: "lease-1", controlGeneration: 2, enabled: true });
    for (const raw of [
      { op: "hostMute", lease: "lease-1", controlGeneration: 0, enabled: true },
      { op: "hostMute", lease: "lease-1", controlGeneration: 2 },
      { op: "hostMute", lease: "lease-1", controlGeneration: 2, enabled: true, owner: "viewer" }
    ]) expect(() => parseRemoteDesktopRequest(raw)).toThrowError("INVALID_REMOTE_DESKTOP_REQUEST");
    expect(parseRemoteDesktopRequest({
      op: "stop", lease: "lease-1", lockScreen: true, controlGeneration: 3
    })).toEqual({ op: "stop", lease: "lease-1", lockScreen: true, controlGeneration: 3 });
    expect(parseRemoteDesktopRequest({ op: "stop", lease: "lease-1", lockScreen: false }))
      .toEqual({ op: "stop", lease: "lease-1" });
    for (const raw of [
      { op: "stop", lease: "lease-1", lockScreen: true },
      { op: "stop", lease: "lease-1", lockScreen: true, controlGeneration: 0 },
      { op: "stop", lease: "lease-1", lockScreen: false, controlGeneration: 3 }
    ]) expect(() => parseRemoteDesktopRequest(raw)).toThrowError("INVALID_REMOTE_DESKTOP_REQUEST");
  });

  it("accepts one bounded portable clipboard item without applying the legacy text limit", () => {
    const longRichText = "x".repeat(20_000);
    expect(parseRemoteDesktopClipboardContentJson(JSON.stringify({
      text: longRichText,
      html: "<p>portable</p>",
      url: "https://example.test/item",
      png: "iVBORw0KGgo="
    }))).toMatchObject({ text: longRichText, url: "https://example.test/item" });
    expect(stringifyRemoteDesktopClipboardContent({
      $typeName: "joko.v1.RemoteDesktopClipboardContent",
      text: "portable"
    })).toBe(JSON.stringify({ text: "portable" }));
    expect(() => parseRemoteDesktopClipboardContentJson(JSON.stringify({ privateFormat: "secret" })))
      .toThrowError("REMOTE_DESKTOP_CLIPBOARD_UNSUPPORTED");
    expect(() => parseRemoteDesktopClipboardContentJson(JSON.stringify({ url: "file:///private/item" })))
      .toThrowError("REMOTE_DESKTOP_CLIPBOARD_UNSUPPORTED");
  });

  it("sanitizes host capabilities and preserves platform safety boundaries", () => {
    expect(parseRemoteDesktopHostCapabilities({
      ...CAPABILITIES,
      ignoredFutureFlag: true
    })).toEqual(CAPABILITIES);
    expect(() => parseRemoteDesktopHostCapabilities({
      ...CAPABILITIES,
      permissions: undefined
    })).toThrowError("INVALID_REMOTE_DESKTOP_CAPABILITIES");
    const linux = { ...CAPABILITIES, platform: "linux", hostMute: false, lockOnExit: false,
      privacyScreen: false, nativeCredentials: false };
    expect(parseRemoteDesktopHostCapabilities(linux)).toEqual(linux);
    expect(parseRemoteDesktopHostCapabilities({ ...linux, hostMute: true }))
      .toMatchObject({ hostMute: true, privacyScreen: false, nativeCredentials: false });
    expect(parseRemoteDesktopHostCapabilities({ ...linux, lockOnExit: true, displayModes: false,
      resolutionRestore: false, cursorOverlay: false, canControl: false }))
      .toMatchObject({ lockOnExit: true, canControl: false, displayModes: false, nativeCredentials: false });
    expect(() => parseRemoteDesktopHostCapabilities({ ...linux, platform: "win32", lockOnExit: true,
      displayModes: false, resolutionRestore: false, cursorOverlay: false })).toThrowError("INVALID_REMOTE_DESKTOP_CAPABILITIES");
    expect(() => parseRemoteDesktopHostCapabilities({ ...linux, displayModes: false }))
      .toThrowError("INVALID_REMOTE_DESKTOP_CAPABILITIES");
    expect(() => parseRemoteDesktopHostCapabilities({ ...linux, platform: "win32" }))
      .toThrowError("INVALID_REMOTE_DESKTOP_CAPABILITIES");
    expect(parseRemoteDesktopHostCapabilities({ ...linux, platform: "win32", displayModes: false,
      resolutionRestore: false, cursorOverlay: true }))
      .toMatchObject({ platform: "win32", cursorOverlay: true, displayModes: false, nativeCredentials: false, lockOnExit: false });
    expect(parseRemoteDesktopHostCapabilities({ ...linux, privacyScreen: true })).toMatchObject({ privacyScreen: true });
    expect(parseRemoteDesktopHostCapabilities({ ...linux, nativeCredentials: true })).toMatchObject({ nativeCredentials: true });
    expect(() => parseRemoteDesktopHostCapabilities({ ...linux, nativeCredentials: true, platform: "win32",
      displayModes: false, resolutionRestore: false, cursorOverlay: false })).toThrowError("INVALID_REMOTE_DESKTOP_CAPABILITIES");
    expect(parseRemoteDesktopHostCapabilities({ ...linux, viewerDisplay: true, viewerDisplayRestore: true }))
      .toMatchObject({ viewerDisplay: true, viewerDisplayRestore: true });
    expect(parseRemoteDesktopHostCapabilities({ ...CAPABILITIES, viewerDisplay: true, viewerDisplayRestore: true }))
      .toMatchObject({ platform: "darwin", viewerDisplay: true, viewerDisplayRestore: true });
    expect(() => parseRemoteDesktopHostCapabilities({ ...linux, platform: "win32", displayModes: false,
      resolutionRestore: false, viewerDisplay: true, viewerDisplayRestore: true }))
      .toThrowError("INVALID_REMOTE_DESKTOP_CAPABILITIES");
    expect(() => parseRemoteDesktopHostCapabilities({ ...linux, viewerDisplayRestore: true }))
      .toThrowError("INVALID_REMOTE_DESKTOP_CAPABILITIES");
  });

  it("accepts only bounded exact viewer Fit and Restore requests", () => {
    expect(parseRemoteDesktopRequest({ op: "viewerDisplay", lease: "lease-1", controlGeneration: 2, width: 320, height: 2560 }))
      .toEqual({ op: "viewerDisplay", lease: "lease-1", controlGeneration: 2, width: 320, height: 2560 });
    expect(parseRemoteDesktopRequest({ op: "restoreViewerDisplay", lease: "lease-1", controlGeneration: 2 }))
      .toEqual({ op: "restoreViewerDisplay", lease: "lease-1", controlGeneration: 2 });
    for (const extra of [{ width: 319 }, { height: 2561 }, { width: 320.5 }, { controlGeneration: 0 }, { sourceDisplayId: "other" }]) {
      expect(() => parseRemoteDesktopRequest({ op: "viewerDisplay", lease: "lease-1", controlGeneration: 2, width: 1280, height: 720, ...extra }))
        .toThrowError("INVALID_REMOTE_DESKTOP_REQUEST");
    }
    expect(() => parseRemoteDesktopRequest({ op: "restoreViewerDisplay", lease: "lease-1", controlGeneration: 2, displayId: "mirror" }))
      .toThrowError("INVALID_REMOTE_DESKTOP_REQUEST");
  });

  it("enforces JPEG byte and dimension limits before a frame can leave the host", () => {
    expect(isBoundedRemoteDesktopJpegFrame({
      jpeg: Buffer.alloc(REMOTE_DESKTOP_MAX_FRAME_BYTES).toString("base64"),
      width: 1_280,
      height: 720
    })).toBe(true);
    expect(isBoundedRemoteDesktopJpegFrame({
      jpeg: Buffer.alloc(REMOTE_DESKTOP_MAX_FRAME_BYTES + 1).toString("base64"),
      width: 1_280,
      height: 720
    })).toBe(false);
    expect(isBoundedRemoteDesktopJpegFrame({ jpeg: "YWJj", width: 1_281, height: 720 })).toBe(false);
  });

  it("bounds macOS display modes and raster cursor metadata", () => {
    expect(parseRemoteDesktopDisplayModes([
      { id: "101", width: 2560, height: 1600, current: true, native: true },
      { id: "102", width: 1920, height: 1200, current: false, native: false }
    ])).toHaveLength(2);
    expect(() => parseRemoteDesktopDisplayModes([
      { id: "101", width: 2560, height: 1600, current: false, native: true }
    ])).toThrowError("INVALID_REMOTE_DESKTOP_DISPLAY_MODES");
    expect(isRemoteDesktopCursor({
      visible: true,
      x: 0.5,
      y: 0.25,
      width: 32,
      height: 32,
      hotX: 4,
      hotY: 5,
      png: cursorPng()
    })).toBe(true);
    expect(isRemoteDesktopCursor({
      visible: true,
      x: 0.5,
      y: 0.25,
      width: 257,
      height: 32,
      hotX: 4,
      hotY: 5,
      png: cursorPng()
    })).toBe(false);
    expect(isRemoteDesktopCursor({
      visible: true,
      x: 0.5,
      y: 0.25,
      width: 32,
      height: 32,
      hotX: 4,
      hotY: 5,
      png: cursorPng(REMOTE_DESKTOP_MAX_CURSOR_RASTER_DIMENSION + 1, 32)
    })).toBe(false);
  });

  it("bounds trickle ICE attempts, candidates and replies", () => {
    const candidates = parseRemoteDesktopIceCandidates([{
      candidate: "candidate:1 1 UDP 1 192.0.2.1 5000 typ host",
      sdpMid: "0",
      sdpMLineIndex: 0
    }]);
    expect(candidates).toHaveLength(1);
    expect(parseRemoteDesktopIceReply({
      attemptId: "attempt_1",
      candidates,
      next: 1,
      complete: false
    })).toMatchObject({ attemptId: "attempt_1", next: 1, complete: false });
    expect(() => parseRemoteDesktopIceCandidates([{
      candidate: "candidate:bad",
      sdpMid: null,
      sdpMLineIndex: null
    }])).toThrowError("INVALID_REMOTE_DESKTOP_ICE");
  });

  it("accepts only short-lived TURN material and fails closed to public STUN", async () => {
    const now = Date.UTC(2026, 0, 1);
    const configured = parseRemoteDesktopIceConfig({
      expiresAt: new Date(now + 180_000).toISOString(),
      ignoredUpstreamField: "not forwarded",
      iceServers: [{
        urls: ["turn:relay.example.test:3478?transport=udp"],
        username: "short-lived-user",
        credential: "short-lived-secret",
        ignored: true
      }]
    }, now);
    expect(configured).toEqual([{
      urls: ["turn:relay.example.test:3478?transport=udp"],
      username: "short-lived-user",
      credential: "short-lived-secret"
    }]);
    expect(() => parseRemoteDesktopIceConfig({
      expiresAt: new Date(now + 60_000).toISOString(),
      iceServers: [{
        urls: ["turn:relay.example.test:3478"], username: "user", credential: "secret"
      }]
    }, now)).toThrowError("INVALID_REMOTE_DESKTOP_ICE_CONFIG");

    await expect(resolveRemoteDesktopIceServers(
      async () => { throw new Error("credential-bearing upstream failure"); },
      { timeoutMs: 10 }
    )).resolves.toEqual([
      { urls: ["stun:stun.cloudflare.com:3478"] },
      { urls: ["stun:stun.l.google.com:19302"] }
    ]);
  });
});

describe("remote desktop finite authority controller", () => {
  it("Linux system audio failure preserves the exact view lease for a muted offer", async () => {
    const fixture = controllerFixture();
    vi.mocked(fixture.dependencies.capabilities).mockResolvedValue({ ...CAPABILITIES, platform: "linux",
      displayModes: false, resolutionRestore: false, hostMute: false, lockOnExit: false,
      privacyScreen: false, nativeCredentials: false, systemAudio: true });
    await expect(fixture.controller.request(AUTHORITY, { op: "capabilities" }))
      .resolves.toMatchObject({ platform: "linux", systemAudio: true });
    const lease = await start(fixture);
    vi.mocked(fixture.dependencies.offer).mockRejectedValueOnce(new Error("REMOTE_DESKTOP_AUDIO_UNAVAILABLE"));
    await expect(fixture.controller.request(AUTHORITY, { op: "offer", lease: lease.lease,
      sdp: "offer", attemptId: "audio-attempt", cursorOverlay: false,
      settings: { fps: 30, quality: "auto", audio: true } })).rejects.toThrow("REMOTE_DESKTOP_AUDIO_UNAVAILABLE");
    expect(fixture.controller.state?.lease).toBe(lease.lease);
    expect(fixture.dependencies.stopVideo).not.toHaveBeenCalled();
    await expect(fixture.controller.request(AUTHORITY, { op: "heartbeat", lease: lease.lease })).resolves.toBeDefined();
    await expect(fixture.controller.request(AUTHORITY, { op: "offer", lease: lease.lease,
      sdp: "offer", attemptId: "muted-attempt", cursorOverlay: false,
      settings: { fps: 30, quality: "auto", audio: false } })).resolves.toEqual({ sdp: "answer" });
    expect(fixture.dependencies.offer).toHaveBeenLastCalledWith(expect.objectContaining({ lease: lease.lease }),
      "offer", "muted-attempt", { fps: 30, quality: "auto", audio: false }, false, AUTHORITY, undefined);
    fixture.controller.stop();
  });

  it("Linux clipboard accepts content fingerprints through an exact sync occurrence without admitting adjacent capabilities", async () => {
    const value = controllerFixture();
    vi.mocked(value.dependencies.capabilities).mockResolvedValue({ ...CAPABILITIES, platform: "linux",
      displayModes: false, resolutionRestore: false, systemAudio: false, hostMute: false, lockOnExit: false,
      privacyScreen: false, nativeCredentials: false, cursorOverlay: false });
    const lease = await start(value);
    const control = await value.controller.request(AUTHORITY, { op: "control", lease: lease.lease, enabled: true }) as { controlGeneration: number };
    const sync = await value.controller.request(AUTHORITY, { op: "clipboardSync", lease: lease.lease,
      controlGeneration: control.controlGeneration, enabled: true }) as { syncGeneration: number };
    const request = { op: "clipboardVersion", lease: lease.lease, controlGeneration: control.controlGeneration, syncGeneration: sync.syncGeneration };
    vi.mocked(value.dependencies.clipboardVersion!).mockResolvedValueOnce("abcdef01".repeat(8));
    await expect(value.controller.request(AUTHORITY, request)).resolves.toEqual({ version: "abcdef01".repeat(8) });
    for (const invalid of ["A".repeat(64), "g".repeat(64), "a".repeat(63), "1".repeat(129)]) {
      vi.mocked(value.dependencies.clipboardVersion!).mockResolvedValueOnce(invalid);
      await expect(value.controller.request(AUTHORITY, request)).rejects.toThrowError("REMOTE_DESKTOP_CLIPBOARD_UNAVAILABLE");
    }
    expect(value.controller.state?.lease).toBe(lease.lease); value.controller.stop();
  });
  it("fences clipboard opt-ins and counters by control and a fresh sync occurrence", async () => {
    const value = controllerFixture();
    const lease = await start(value);
    await expect(value.controller.request(AUTHORITY, { op: "clipboardSync", lease: lease.lease,
      controlGeneration: lease.controlGeneration, enabled: true })).rejects.toThrowError("REMOTE_DESKTOP_CLIPBOARD_EXPIRED");
    const control = await value.controller.request(AUTHORITY, { op: "control", lease: lease.lease, enabled: true }) as { controlGeneration: number };
    const enable = () => value.controller.request(AUTHORITY, { op: "clipboardSync", lease: lease.lease,
      controlGeneration: control.controlGeneration, enabled: true }) as Promise<{ enabled: boolean; syncGeneration: number }>;
    const first = await enable();
    const request = { op: "clipboardVersion", lease: lease.lease, controlGeneration: control.controlGeneration, syncGeneration: first.syncGeneration };
    await expect(value.controller.request(AUTHORITY, request)).resolves.toEqual({ version: "1" });
    let complete!: (version: string) => void;
    vi.mocked(value.dependencies.clipboardVersion!).mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
    const pending = value.controller.request(AUTHORITY, request);
    const rejected = expect(pending).rejects.toThrowError("REMOTE_DESKTOP_CLIPBOARD_EXPIRED");
    await value.controller.request(AUTHORITY, { op: "clipboardSync", lease: lease.lease,
      controlGeneration: control.controlGeneration, enabled: false });
    const next = await enable();
    expect(next.syncGeneration).toBeGreaterThan(first.syncGeneration);
    complete("2"); await rejected;
    expect(value.controller.state?.lease).toBe(lease.lease);
    await value.controller.request(AUTHORITY, { op: "control", lease: lease.lease, enabled: false });
    expect(value.controller.isClipboardSyncCurrent(AUTHORITY, lease.lease, control.controlGeneration, next.syncGeneration)).toBe(false);
    expect(value.dependencies.stopClipboardVersion).toHaveBeenCalled();
  });
  it("binds a 12-second lease, renews it, and expires it fail-closed", async () => {
    const fixture = controllerFixture();
    const capabilities = await fixture.controller.request(AUTHORITY, { op: "capabilities" });
    expect(capabilities).toMatchObject({
      automaticReconnect: true,
      connectionTakeover: true,
      webrtcVideo: true,
      trickleIce: true,
      jpegFallback: true
    });
    const lease = await start(fixture);
    expect(fixture.controller.state).toMatchObject({ lease: lease.lease, controlling: false });

    fixture.now += REMOTE_DESKTOP_LEASE_MS - 1;
    await expect(fixture.controller.request(AUTHORITY, {
      op: "heartbeat", lease: lease.lease
    })).resolves.toMatchObject({ controlling: false, controlGeneration: lease.controlGeneration });
    fixture.now += REMOTE_DESKTOP_LEASE_MS - 1;
    fixture.controller.tick();
    expect(fixture.controller.state).toBeDefined();
    fixture.now += 1;
    fixture.controller.tick();
    expect(fixture.controller.state).toBeUndefined();
    expect(fixture.dependencies.stopVideo).toHaveBeenCalledTimes(1);
  });

  it("makes presentation view-only and renews only from trusted monotonic pongs", async () => {
    const fixture = controllerFixture();
    const lease = await start(fixture);
    const controlled = await fixture.controller.request(AUTHORITY, {
      op: "control", lease: lease.lease, enabled: true
    }) as { readonly controlGeneration: number };
    const presentation = await fixture.controller.request(AUTHORITY, {
      op: "presentation", lease: lease.lease, enabled: true
    });
    expect(presentation).toEqual({ controlling: false, controlGeneration: controlled.controlGeneration + 1 });
    expect(fixture.dependencies.stopInput).toHaveBeenCalled();
    expect(fixture.controller.probePresentation(AUTHORITY, lease.lease)).toEqual({
      lease: lease.lease,
      proofSequence: 0
    });

    fixture.now += REMOTE_DESKTOP_LEASE_MS - 1;
    fixture.controller.recordPresentationPong("stale-lease");
    expect(fixture.controller.probePresentation(AUTHORITY, lease.lease).proofSequence).toBe(0);
    fixture.controller.recordPresentationPong(lease.lease);
    expect(fixture.controller.probePresentation(AUTHORITY, lease.lease).proofSequence).toBe(1);
    fixture.now += REMOTE_DESKTOP_LEASE_MS - 1;
    fixture.controller.tick();
    expect(fixture.controller.state).toBeDefined();

    await fixture.controller.request(AUTHORITY, { op: "control", lease: lease.lease, enabled: true });
    fixture.controller.recordPresentationPong(lease.lease);
    expect(() => fixture.controller.probePresentation(AUTHORITY, lease.lease))
      .toThrowError("REMOTE_DESKTOP_LEASE_EXPIRED");
  });

  it("fences automatic resume after local Disconnect but permits an explicit fresh start", async () => {
    const fixture = controllerFixture();
    const lease = await start(fixture);
    fixture.controller.stopByUser();
    await expect(fixture.controller.request(AUTHORITY, {
      op: "start", displayId: "display-1", resume: true
    })).rejects.toThrowError("REMOTE_DESKTOP_STOPPED");
    const replacement = await start(fixture);
    expect(replacement.lease).not.toBe(lease.lease);
  });

  it("requires explicit takeover and rotates the single viewer lease", async () => {
    const fixture = controllerFixture();
    const first = await start(fixture);
    await expect(fixture.controller.request(OTHER_AUTHORITY, {
      op: "start", displayId: "display-1"
    })).rejects.toThrowError("REMOTE_DESKTOP_BUSY");
    const second = await fixture.controller.request(OTHER_AUTHORITY, {
      op: "start", displayId: "display-1", takeover: true
    }) as { readonly lease: string };
    expect(second.lease).not.toBe(first.lease);
    expect(fixture.controller.state?.controllerDeviceId).toBe("controller-b");
  });

  it("keeps picture and lease while input failures downgrade to view-only", async () => {
    const fixture = controllerFixture();
    const lease = await start(fixture);
    await fixture.controller.request(AUTHORITY, {
      op: "control", lease: lease.lease, enabled: true
    });
    expect(fixture.controller.state?.controlling).toBe(true);
    const firstGeneration = fixture.controller.state!.controlGeneration;
    expect(fixture.controller.isControlCurrent(AUTHORITY, lease.lease, firstGeneration)).toBe(true);

    vi.mocked(fixture.dependencies.input).mockImplementationOnce(() => {
      throw new Error("native input unavailable");
    });
    await expect(fixture.controller.request(AUTHORITY, {
      op: "input",
      lease: lease.lease,
      sequence: 1,
      events: [{ kind: "button", button: 0, down: true, x: 0.5, y: 0.5 }]
    })).rejects.toThrowError("native input unavailable");
    expect(fixture.controller.state).toMatchObject({ lease: lease.lease, controlling: false });
    expect(fixture.controller.isControlCurrent(AUTHORITY, lease.lease, firstGeneration)).toBe(false);
    expect(fixture.dependencies.stopVideo).not.toHaveBeenCalled();

    await fixture.controller.request(AUTHORITY, {
      op: "control", lease: lease.lease, enabled: true
    });
    expect(fixture.controller.state!.controlGeneration).toBeGreaterThan(firstGeneration);
    await fixture.controller.request(AUTHORITY, {
      op: "input", lease: lease.lease, sequence: 2, events: [{ kind: "release" }]
    });
    await fixture.controller.request(AUTHORITY, {
      op: "input", lease: lease.lease, sequence: 2, events: [{ kind: "release" }]
    });
    expect(fixture.dependencies.input).toHaveBeenCalledTimes(2);
  });

  it("cleans a failed input start and leaves the current lease view-only", async () => {
    const fixture = controllerFixture();
    const lease = await start(fixture);
    vi.mocked(fixture.dependencies.startInput).mockRejectedValueOnce(
      new Error("native input unavailable")
    );

    await expect(fixture.controller.request(AUTHORITY, {
      op: "control", lease: lease.lease, enabled: true
    })).rejects.toThrowError("native input unavailable");
    expect(fixture.controller.state).toMatchObject({ lease: lease.lease, controlling: false });
    expect(fixture.dependencies.stopInput).toHaveBeenCalledTimes(1);
    expect(fixture.dependencies.stopVideo).not.toHaveBeenCalled();
  });

  it("fences an in-flight input start when the host releases control", async () => {
    const fixture = controllerFixture();
    const lease = await start(fixture);
    let finishInput!: () => void;
    vi.mocked(fixture.dependencies.startInput).mockImplementationOnce(() => new Promise((resolve) => {
      finishInput = resolve;
    }));

    const pending = fixture.controller.request(AUTHORITY, {
      op: "control", lease: lease.lease, enabled: true
    });
    await vi.waitFor(() => expect(fixture.dependencies.startInput).toHaveBeenCalledOnce());
    const pendingGeneration = fixture.controller.state!.controlGeneration;

    fixture.controller.releaseControl();
    expect(fixture.controller.state).toMatchObject({ lease: lease.lease, controlling: false });
    expect(fixture.controller.state!.controlGeneration).toBeGreaterThan(pendingGeneration);
    expect(fixture.dependencies.stopInput).toHaveBeenCalledOnce();

    finishInput();
    await expect(pending).rejects.toThrowError("REMOTE_DESKTOP_LEASE_EXPIRED");
    expect(fixture.controller.state).toMatchObject({ lease: lease.lease, controlling: false });
    expect(fixture.dependencies.stopInput).toHaveBeenCalledTimes(3);
    expect(fixture.dependencies.stopVideo).not.toHaveBeenCalled();
  });

  it("keeps a non-controlling platform view-only without touching native input", async () => {
    const fixture = controllerFixture();
    vi.mocked(fixture.dependencies.capabilities).mockResolvedValue({
      ...CAPABILITIES,
      platform: "linux",
      canControl: false,
      hostMute: false,
      lockOnExit: false,
      clipboardSync: false,
      clipboardInline: false,
      privacyScreen: false,
      nativeCredentials: false,
      resolutionRestore: false,
      displayModes: false,
      cursorOverlay: false,
      permissions: { screenRecording: "granted", accessibility: "notRequired" }
    });
    const lease = await start(fixture);

    await expect(fixture.controller.request(AUTHORITY, {
      op: "control", lease: lease.lease, enabled: true
    })).rejects.toThrowError("REMOTE_DESKTOP_VIEW_ONLY");
    expect(fixture.controller.state).toMatchObject({ lease: lease.lease, controlling: false });
    expect(fixture.dependencies.startInput).not.toHaveBeenCalled();
  });

  it("capture pending keeps its view lease and a frame occurrence retires with its exact owner", async () => {
    const fixture = controllerFixture();
    const lease = await start(fixture);
    vi.mocked(fixture.dependencies.offer).mockRejectedValueOnce(new Error("REMOTE_DESKTOP_CAPTURE_PENDING"));
    await expect(fixture.controller.request(AUTHORITY, { op: "offer", lease: lease.lease,
      sdp: "offer", attemptId: "portal-attempt", cursorOverlay: false })).rejects.toThrow("REMOTE_DESKTOP_CAPTURE_PENDING");
    expect(fixture.controller.state?.lease).toBe(lease.lease);
    let captured!: Parameters<RemoteDesktopControllerDependencies["frame"]>[0];
    vi.mocked(fixture.dependencies.frame).mockImplementationOnce(async request => { captured = request; return null; });
    await fixture.controller.request(AUTHORITY, { op: "frame", lease: lease.lease, cursorOverlay: false });
    expect(captured.leaseId).toBe(lease.lease); expect(captured.current()).toBe(true);
    fixture.controller.stop(AUTHORITY); await start(fixture);
    expect(captured.current()).toBe(false);
  });

  it("allows a Linux native cursor probe without admitting Mac mode or safety capabilities", async () => {
    const fixture = controllerFixture();
    vi.mocked(fixture.dependencies.capabilities).mockResolvedValue({ ...CAPABILITIES, platform: "linux",
      canControl: true, cursorOverlay: true, displayModes: false, resolutionRestore: false, hostMute: false,
      lockOnExit: false, privacyScreen: false, nativeCredentials: false, clipboardSync: false, clipboardInline: false });
    const lease = await start(fixture);
    await expect(fixture.controller.request(AUTHORITY, { op: "control", lease: lease.lease, enabled: true }))
      .resolves.toMatchObject({ controlling: true });
    await fixture.controller.request(AUTHORITY, { op: "frame", lease: lease.lease, cursorOverlay: true });
    expect(fixture.dependencies.frame).toHaveBeenCalledWith(expect.objectContaining({ cursorOverlay: true }), AUTHORITY);
  });

  it("keeps only one JPEG request in flight and applies the four-fps gate", async () => {
    const fixture = controllerFixture();
    const lease = await start(fixture);
    let releaseFrame!: (frame: { readonly jpeg: string; readonly width: number; readonly height: number }) => void;
    vi.mocked(fixture.dependencies.frame).mockImplementationOnce(() => new Promise((resolve) => {
      releaseFrame = resolve;
    }));
    const first = fixture.controller.request(AUTHORITY, {
      op: "frame", lease: lease.lease, cursorOverlay: false
    });
    await vi.waitFor(() => expect(fixture.dependencies.frame).toHaveBeenCalledTimes(1));
    await expect(fixture.controller.request(AUTHORITY, {
      op: "frame", lease: lease.lease, cursorOverlay: false
    })).resolves.toEqual({ jpeg: null });
    releaseFrame({ jpeg: "YWJj", width: 3, height: 1 });
    await expect(first).resolves.toEqual({ jpeg: "YWJj" });

    fixture.now += REMOTE_DESKTOP_FRAME_INTERVAL_MS - 1;
    await expect(fixture.controller.request(AUTHORITY, {
      op: "frame", lease: lease.lease, cursorOverlay: false
    })).resolves.toEqual({ jpeg: null });
    fixture.now += 1;
    vi.mocked(fixture.dependencies.frame).mockResolvedValueOnce({ jpeg: "YWJj", width: 1_281, height: 1 });
    await expect(fixture.controller.request(AUTHORITY, {
      op: "frame", lease: lease.lease, cursorOverlay: false
    })).resolves.toEqual({ jpeg: null });
  });

  it("forwards a bounded native cursor only for an explicit overlay request", async () => {
    const fixture = controllerFixture();
    const lease = await start(fixture);
    vi.mocked(fixture.dependencies.frame).mockResolvedValueOnce({
      jpeg: "YWJj",
      width: 3,
      height: 1,
      cursor: {
        visible: true,
        x: 0.5,
        y: 0.25,
        width: 32,
        height: 32,
        hotX: 4,
        hotY: 5,
        png: cursorPng()
      }
    });
    await expect(fixture.controller.request(AUTHORITY, {
      op: "frame", lease: lease.lease, cursorOverlay: true
    })).resolves.toMatchObject({
      jpeg: "YWJj",
      cursor: { visible: true, x: 0.5, y: 0.25, png: cursorPng() }
    });
    expect(fixture.dependencies.frame).toHaveBeenCalledWith({ displayId: "display-1", leaseId: lease.lease,
      cursorOverlay: true, current: expect.any(Function) }, AUTHORITY);

    fixture.now += REMOTE_DESKTOP_FRAME_INTERVAL_MS;
    vi.mocked(fixture.dependencies.frame).mockResolvedValueOnce({
      jpeg: "YWJj",
      width: 3,
      height: 1,
      cursor: null
    });
    await expect(fixture.controller.request(AUTHORITY, {
      op: "frame", lease: lease.lease, cursorOverlay: true
    })).resolves.toEqual({ jpeg: "YWJj", cursor: null });
  });

  it("lists lease-bound modes and makes a mode write terminal before native mutation", async () => {
    const fixture = controllerFixture();
    const lease = await start(fixture);
    const controlled = await fixture.controller.request(AUTHORITY, {
      op: "control", lease: lease.lease, enabled: true
    }) as { readonly controlGeneration: number };
    await expect(fixture.controller.request(AUTHORITY, {
      op: "displayModes", lease: lease.lease
    })).resolves.toEqual([
      { id: "101", width: 1_280, height: 800, current: true, native: true },
      { id: "102", width: 1_024, height: 640, current: false, native: false }
    ]);

    let finish!: () => void;
    vi.mocked(fixture.dependencies.setDisplayMode!).mockImplementationOnce(
      async (_displayId, _modeId, beforeChange) => {
        await beforeChange();
        await new Promise<void>((resolve) => { finish = resolve; });
      }
    );
    const pending = fixture.controller.request(AUTHORITY, {
      op: "resolution",
      lease: lease.lease,
      controlGeneration: controlled.controlGeneration,
      modeId: "102", temporary: false
    });
    await vi.waitFor(() => expect(fixture.controller.state).toBeUndefined());
    await expect(fixture.controller.request(AUTHORITY, {
      op: "start", displayId: "display-1"
    })).rejects.toThrowError("REMOTE_DESKTOP_DISPLAY_BUSY");
    finish();
    await expect(pending).resolves.toEqual({});
    await expect(start(fixture)).resolves.toMatchObject({ display: { id: "display-1" } });
  });

  it("keeps pre-effect mode failures but hides a domain error after native mutation becomes possible", async () => {
    const fixture = controllerFixture();
    const lease = await start(fixture);
    const controlled = await fixture.controller.request(AUTHORITY, {
      op: "control", lease: lease.lease, enabled: true
    }) as { readonly controlGeneration: number };
    await expect(fixture.controller.request(AUTHORITY, {
      op: "resolution",
      lease: lease.lease,
      controlGeneration: controlled.controlGeneration,
      modeId: "999", temporary: false
    })).rejects.toThrowError("REMOTE_DESKTOP_DISPLAY_MODE_MISSING");
    expect(fixture.controller.state).toMatchObject({ lease: lease.lease, controlling: true });

    vi.mocked(fixture.dependencies.setDisplayMode!).mockImplementationOnce(
      async (_displayId, _modeId, beforeChange) => {
        await beforeChange();
        throw new Error("REMOTE_DESKTOP_DISPLAY_MODES_UNAVAILABLE");
      }
    );
    await expect(fixture.controller.request(AUTHORITY, {
      op: "resolution",
      lease: lease.lease,
      controlGeneration: controlled.controlGeneration,
      modeId: "102", temporary: false
    })).rejects.toThrowError("REMOTE_DESKTOP_LEASE_EXPIRED");
    expect(fixture.controller.state).toBeUndefined();
  });

  it("revalidates exact authority after asynchronous signaling and tears down stale capture", async () => {
    const fixture = controllerFixture();
    const lease = await start(fixture);
    let answer!: (sdp: string) => void;
    vi.mocked(fixture.dependencies.offer).mockImplementationOnce(() => new Promise((resolve) => {
      answer = resolve;
    }));
    const pending = fixture.controller.request(AUTHORITY, {
      op: "offer", lease: lease.lease, attemptId: "attempt-1", sdp: "offer", cursorOverlay: false
    });
    await vi.waitFor(() => expect(fixture.dependencies.offer).toHaveBeenCalledTimes(1));
    fixture.currentAuthorities.delete(authorityKey(AUTHORITY));
    answer("answer");
    await expect(pending).rejects.toThrowError("REMOTE_DESKTOP_ACCESS_REVOKED");
    expect(fixture.controller.state).toBeUndefined();
    expect(fixture.dependencies.stopVideo).toHaveBeenCalledTimes(1);
  });

  it("revalidates authority when signaling rejects and does not leak the native failure", async () => {
    const fixture = controllerFixture();
    const lease = await start(fixture);
    let rejectExchange!: (reason: Error) => void;
    vi.mocked(fixture.dependencies.ice!).mockImplementationOnce(() => new Promise((_resolve, reject) => {
      rejectExchange = reject;
    }));
    const pending = fixture.controller.request(AUTHORITY, {
      op: "ice", lease: lease.lease, attemptId: "attempt-1", candidates: [], after: 0
    });
    await vi.waitFor(() => expect(fixture.dependencies.ice).toHaveBeenCalledTimes(1));
    fixture.currentAuthorities.delete(authorityKey(AUTHORITY));
    rejectExchange(new Error("native diagnostic must not become authority"));

    await expect(pending).rejects.toThrowError("REMOTE_DESKTOP_ACCESS_REVOKED");
    expect(fixture.controller.state).toBeUndefined();
    expect(fixture.dependencies.stopVideo).toHaveBeenCalledTimes(1);
  });

  it("keeps an old frame in the one-flight gate across lease replacement", async () => {
    const fixture = controllerFixture();
    const firstLease = await start(fixture);
    let releaseFrame!: (frame: { readonly jpeg: string; readonly width: number; readonly height: number }) => void;
    vi.mocked(fixture.dependencies.frame).mockImplementationOnce(() => new Promise((resolve) => {
      releaseFrame = resolve;
    }));
    const oldFrame = fixture.controller.request(AUTHORITY, {
      op: "frame", lease: firstLease.lease, cursorOverlay: false
    });
    await vi.waitFor(() => expect(fixture.dependencies.frame).toHaveBeenCalledTimes(1));
    await fixture.controller.request(AUTHORITY, { op: "stop", lease: firstLease.lease });
    const replacement = await start(fixture);

    await expect(fixture.controller.request(AUTHORITY, {
      op: "frame", lease: replacement.lease, cursorOverlay: false
    })).resolves.toEqual({ jpeg: null });
    expect(fixture.dependencies.frame).toHaveBeenCalledTimes(1);
    releaseFrame({ jpeg: "YWJj", width: 3, height: 1 });
    await expect(oldFrame).rejects.toThrowError("REMOTE_DESKTOP_LEASE_EXPIRED");
  });

  it("rejects a retired executor lifecycle before touching host capabilities", async () => {
    const fixture = controllerFixture();
    await expect(fixture.controller.request({
      ...AUTHORITY,
      lifecycleToken: RETIRED_LIFECYCLE_TOKEN
    }, { op: "capabilities" })).rejects.toThrowError("REMOTE_DESKTOP_ACCESS_REVOKED");
    expect(fixture.dependencies.capabilities).not.toHaveBeenCalled();
  });

  it("owns host mute by the exact control occurrence and restores before a new generation", async () => {
    const fixture = controllerFixture();
    const lease = await start(fixture);
    const control = await fixture.controller.request(AUTHORITY, {
      op: "control", lease: lease.lease, enabled: true
    }) as { controlGeneration: number };
    await fixture.controller.request(AUTHORITY, {
      op: "hostMute", lease: lease.lease, controlGeneration: control.controlGeneration, enabled: true
    });
    const firstOwner = vi.mocked(fixture.dependencies.hostMute!).mock.calls[0]![0];
    await fixture.controller.request(AUTHORITY, { op: "control", lease: lease.lease, enabled: false });
    expect(fixture.dependencies.stopHostMute).toHaveBeenCalledWith(firstOwner);
    const next = await fixture.controller.request(AUTHORITY, {
      op: "control", lease: lease.lease, enabled: true
    }) as { controlGeneration: number };
    await expect(fixture.controller.request(AUTHORITY, {
      op: "hostMute", lease: lease.lease, controlGeneration: control.controlGeneration, enabled: true
    })).rejects.toThrowError("REMOTE_DESKTOP_HOST_MUTE_EXPIRED");
    await fixture.controller.request(AUTHORITY, {
      op: "hostMute", lease: lease.lease, controlGeneration: next.controlGeneration, enabled: true
    });
    const nextOwner = vi.mocked(fixture.dependencies.hostMute!).mock.calls[1]![0];
    expect(nextOwner).not.toBe(firstOwner);
    await fixture.controller.stopAndRestore();
    expect(fixture.dependencies.stopHostMute).toHaveBeenLastCalledWith(nextOwner);
  });

  it("rejects a late mute effect, restores its token and preserves the view-only lease", async () => {
    const fixture = controllerFixture();
    const lease = await start(fixture);
    const control = await fixture.controller.request(AUTHORITY, {
      op: "control", lease: lease.lease, enabled: true
    }) as { controlGeneration: number };
    let complete!: () => void;
    vi.mocked(fixture.dependencies.hostMute!).mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => { complete = resolve; });
    });
    const pending = fixture.controller.request(AUTHORITY, {
      op: "hostMute", lease: lease.lease, controlGeneration: control.controlGeneration, enabled: true
    });
    const outcome = expect(pending).rejects.toThrowError("REMOTE_DESKTOP_HOST_MUTE_EXPIRED");
    await vi.waitFor(() => expect(fixture.dependencies.hostMute).toHaveBeenCalledOnce());
    const released = fixture.controller.request(AUTHORITY, {
      op: "control", lease: lease.lease, enabled: false
    });
    complete();
    await outcome;
    await released;
    expect(fixture.dependencies.stopHostMute).toHaveBeenCalled();
    expect(fixture.controller.state).toMatchObject({ lease: lease.lease, controlling: false });
    expect(fixture.dependencies.stopVideo).not.toHaveBeenCalled();
  });

  it("keeps a failed native mute retryable without retiring picture or control", async () => {
    const fixture = controllerFixture();
    const lease = await start(fixture);
    const control = await fixture.controller.request(AUTHORITY, {
      op: "control", lease: lease.lease, enabled: true
    }) as { controlGeneration: number };
    vi.mocked(fixture.dependencies.hostMute!).mockRejectedValueOnce(new Error("REMOTE_DESKTOP_HOST_MUTE_UNAVAILABLE"));
    const request = { op: "hostMute", lease: lease.lease, controlGeneration: control.controlGeneration, enabled: true };
    await expect(fixture.controller.request(AUTHORITY, request))
      .rejects.toThrowError("REMOTE_DESKTOP_HOST_MUTE_UNAVAILABLE");
    expect(fixture.controller.state).toMatchObject({ lease: lease.lease, controlling: true });
    expect(fixture.dependencies.stopVideo).not.toHaveBeenCalled();
    await expect(fixture.controller.request(AUTHORITY, request)).resolves.toEqual({ enabled: true });
    await fixture.controller.stopAndRestore();
  });

  it("reports failed restoration and retries the captured token after its lease ended", async () => {
    const fixture = controllerFixture();
    const lease = await start(fixture);
    const control = await fixture.controller.request(AUTHORITY, {
      op: "control", lease: lease.lease, enabled: true
    }) as { controlGeneration: number };
    await fixture.controller.request(AUTHORITY, {
      op: "hostMute", lease: lease.lease, controlGeneration: control.controlGeneration, enabled: true
    });
    const owner = vi.mocked(fixture.dependencies.hostMute!).mock.calls[0]![0];
    vi.mocked(fixture.dependencies.stopHostMute!).mockRejectedValueOnce(new Error("REMOTE_DESKTOP_HOST_MUTE_UNAVAILABLE"));
    await expect(fixture.controller.request(AUTHORITY, { op: "stop", lease: lease.lease }))
      .rejects.toThrowError("REMOTE_DESKTOP_HOST_MUTE_UNAVAILABLE");
    expect(fixture.controller.state).toBeUndefined();
    await expect(fixture.controller.stopAndRestore()).resolves.toBeUndefined();
    expect(vi.mocked(fixture.dependencies.stopHostMute!).mock.calls.map(([token]) => token)).toEqual([owner, owner]);
  });

  it.each(["presentation", "expired", "revoked"])("restores host mute on %s retirement", async (cause) => {
    const fixture = controllerFixture();
    const lease = await start(fixture);
    const control = await fixture.controller.request(AUTHORITY, {
      op: "control", lease: lease.lease, enabled: true
    }) as { controlGeneration: number };
    await fixture.controller.request(AUTHORITY, {
      op: "hostMute", lease: lease.lease, controlGeneration: control.controlGeneration, enabled: true
    });
    if (cause === "presentation") {
      await fixture.controller.request(AUTHORITY, { op: "presentation", lease: lease.lease, enabled: true });
      expect(fixture.controller.state?.lease).toBe(lease.lease);
    } else {
      if (cause === "expired") fixture.now += REMOTE_DESKTOP_LEASE_MS + 1;
      else fixture.currentAuthorities.delete(authorityKey(AUTHORITY));
      fixture.controller.tick();
      await vi.waitFor(() => expect(fixture.dependencies.stopHostMute).toHaveBeenCalledOnce());
      expect(fixture.controller.state).toBeUndefined();
    }
    expect(fixture.dependencies.stopHostMute).toHaveBeenCalledOnce();
  });

  it("locks an exact view-only lease only on explicit exit", async () => {
    const fixture = controllerFixture();
    const lease = await start(fixture);
    await expect(fixture.controller.request(OTHER_AUTHORITY, {
      op: "stop", lease: lease.lease, lockScreen: true, controlGeneration: lease.controlGeneration
    })).rejects.toThrowError("REMOTE_DESKTOP_LOCK_EXPIRED");
    await expect(fixture.controller.request(AUTHORITY, {
      op: "stop", lease: lease.lease, lockScreen: true, controlGeneration: lease.controlGeneration + 1
    })).rejects.toThrowError("REMOTE_DESKTOP_LOCK_EXPIRED");
    expect(fixture.dependencies.lockScreen).not.toHaveBeenCalled();
    expect(fixture.controller.state?.controlling).toBe(false);
    vi.mocked(fixture.dependencies.lockScreen!).mockImplementationOnce(async (current) => {
      expect(current()).toBe(true);
      expect(fixture.controller.state?.controlling).toBe(false);
    });
    await expect(fixture.controller.request(AUTHORITY, {
      op: "stop", lease: lease.lease, lockScreen: true, controlGeneration: lease.controlGeneration
    })).resolves.toEqual({ ok: true });
    expect(fixture.dependencies.releaseInput).toHaveBeenCalledOnce();
    expect(fixture.controller.state).toBeUndefined();
    const next = await start(fixture);
    await fixture.controller.request(AUTHORITY, { op: "stop", lease: next.lease });
    expect(fixture.dependencies.lockScreen).toHaveBeenCalledOnce();
  });

  it("privacy joins one initialization and adopts only the latest acknowledged lock intent", async () => {
    const fixture = controllerFixture();
    const lease = await start(fixture);
    const control = await fixture.controller.request(AUTHORITY, { op: "control", lease: lease.lease, enabled: true }) as { controlGeneration: number };
    let ready!: () => void;
    vi.mocked(fixture.dependencies.privacyScreen!).mockImplementationOnce(async () => new Promise<void>((resolve) => { ready = resolve; }));
    const request = { op: "privacyScreen", lease: lease.lease, controlGeneration: control.controlGeneration, enabled: true, lockOnExit: true };
    const first = fixture.controller.request(AUTHORITY, request);
    await vi.waitFor(() => expect(fixture.dependencies.privacyScreen).toHaveBeenCalledOnce());
    const second = fixture.controller.request(AUTHORITY, { ...request, lockOnExit: false });
    ready();
    await expect(first).resolves.toEqual({ enabled: true });
    await expect(second).resolves.toEqual({ enabled: true });
    const owner = vi.mocked(fixture.dependencies.privacyScreen!).mock.calls[0]![0];
    await fixture.controller.stopPrivacyByUser(owner);
    expect(fixture.dependencies.lockScreen).not.toHaveBeenCalled();
    expect(fixture.dependencies.stopPrivacyScreen).toHaveBeenCalledExactlyOnceWith(owner);
    expect(fixture.controller.state).toBeUndefined();
    await expect(fixture.controller.request(AUTHORITY, request)).rejects.toThrowError("REMOTE_DESKTOP_PRIVACY_EXPIRED");
  });

  it("privacy off waits actual initialization settlement and rejects replay while the slot is occupied", async () => {
    const fixture = controllerFixture();
    const lease = await start(fixture);
    const control = await fixture.controller.request(AUTHORITY, { op: "control", lease: lease.lease, enabled: true }) as { controlGeneration: number };
    let ready!: () => void;
    vi.mocked(fixture.dependencies.privacyScreen!).mockImplementationOnce(async () => new Promise<void>((resolve) => { ready = resolve; }));
    const request = { op: "privacyScreen", lease: lease.lease, controlGeneration: control.controlGeneration, enabled: true, lockOnExit: false };
    const first = expect(fixture.controller.request(AUTHORITY, request)).rejects.toThrowError("REMOTE_DESKTOP_PRIVACY_EXPIRED");
    await vi.waitFor(() => expect(fixture.dependencies.privacyScreen).toHaveBeenCalledOnce());
    const owner = vi.mocked(fixture.dependencies.privacyScreen!).mock.calls[0]![0];
    const off = expect(fixture.controller.request(AUTHORITY, { ...request, enabled: false })).rejects.toThrowError("REMOTE_DESKTOP_PRIVACY_EXPIRED");
    await expect(fixture.controller.request(AUTHORITY, request)).rejects.toThrowError("REMOTE_DESKTOP_PRIVACY_FAILED");
    expect(fixture.dependencies.stopPrivacyScreen).not.toHaveBeenCalled();
    ready();
    await first;
    await off;
    await expect(fixture.controller.request(AUTHORITY, { ...request, enabled: false })).resolves.toEqual({ enabled: false });
    expect(fixture.dependencies.stopPrivacyScreen).toHaveBeenCalledExactlyOnceWith(owner);
    expect(fixture.controller.state?.lease).toBe(lease.lease);
  });

  it.each(["restored", "retired", "failed"] as const)("privacy off resumes paused input only after native cleanup: %s", async (result) => {
    const fixture = controllerFixture();
    const lease = await start(fixture);
    const control = await fixture.controller.request(AUTHORITY, { op: "control", lease: lease.lease, enabled: true }) as { controlGeneration: number };
    const request = { op: "privacyScreen", lease: lease.lease, controlGeneration: control.controlGeneration, enabled: true, lockOnExit: false };
    await fixture.controller.request(AUTHORITY, request);
    const owner = vi.mocked(fixture.dependencies.privacyScreen!).mock.calls[0]![0];
    let cleanup!: () => void, restore!: () => void, current!: () => boolean;
    vi.mocked(fixture.dependencies.stopPrivacyScreen!).mockImplementationOnce(() => new Promise<void>(resolve => { cleanup = resolve; }));
    fixture.dependencies.resumeInputAfterPrivacy = vi.fn(async (displayId, valid) => {
      expect(displayId).toBe(lease.display.id); current = valid; expect(current()).toBe(true);
      await new Promise<void>(resolve => { restore = resolve; });
      if (result === "failed") throw new Error("native input failed");
    });
    const pending = fixture.controller.request(AUTHORITY, { ...request, enabled: false });
    const receipt = result === "restored" ? expect(pending).resolves.toEqual({ enabled: false })
      : expect(pending).rejects.toThrowError(result === "failed" ? "REMOTE_DESKTOP_PRIVACY_FAILED" : "REMOTE_DESKTOP_LEASE_EXPIRED");
    await vi.waitFor(() => expect(fixture.dependencies.stopPrivacyScreen).toHaveBeenCalledWith(owner));
    expect(fixture.dependencies.resumeInputAfterPrivacy).not.toHaveBeenCalled();
    cleanup();
    await vi.waitFor(() => expect(fixture.dependencies.resumeInputAfterPrivacy).toHaveBeenCalledOnce());
    await expect(fixture.controller.request(AUTHORITY, request)).rejects.toThrowError("REMOTE_DESKTOP_PRIVACY_FAILED");
    if (result === "retired") { fixture.controller.stop(AUTHORITY); expect(current()).toBe(false); }
    restore(); await receipt;
    if (result === "restored") expect(fixture.controller.state).toMatchObject({ lease: lease.lease, controlling: true });
    if (result === "failed") expect(fixture.controller.state).toMatchObject({ lease: lease.lease, controlling: false });
    if (result === "retired") expect(fixture.controller.state).toBeUndefined();
  });

  it("privacy local terminal retains masks through the captured lock and ignores its old owner later", async () => {
    const fixture = controllerFixture();
    const lease = await start(fixture);
    const control = await fixture.controller.request(AUTHORITY, { op: "control", lease: lease.lease, enabled: true }) as { controlGeneration: number };
    await fixture.controller.request(AUTHORITY, { op: "privacyScreen", lease: lease.lease, controlGeneration: control.controlGeneration, enabled: true, lockOnExit: true });
    const owner = vi.mocked(fixture.dependencies.privacyScreen!).mock.calls[0]![0];
    let locked!: () => void;
    vi.mocked(fixture.dependencies.lockScreen!).mockImplementationOnce(async () => new Promise<void>((resolve) => { locked = resolve; }));
    const exiting = fixture.controller.stopPrivacyByUser(owner);
    await vi.waitFor(() => expect(fixture.dependencies.lockScreen).toHaveBeenCalledOnce());
    expect(fixture.dependencies.releaseInput).toHaveBeenCalledOnce();
    expect(fixture.dependencies.stopPrivacyScreen).not.toHaveBeenCalled();
    await expect(fixture.controller.request(OTHER_AUTHORITY, { op: "start", displayId: "display-1", takeover: true })).rejects.toThrowError("REMOTE_DESKTOP_BUSY");
    locked(); await exiting;
    expect(fixture.dependencies.stopPrivacyScreen).toHaveBeenCalledExactlyOnceWith(owner);
    const replacement = await fixture.controller.request(OTHER_AUTHORITY, { op: "start", displayId: "display-1" }) as RemoteDesktopLease;
    await expect(fixture.controller.stopPrivacyByUser(owner)).rejects.toThrowError("REMOTE_DESKTOP_PRIVACY_EXPIRED");
    expect(fixture.controller.state?.lease).toBe(replacement.lease);
    expect(fixture.dependencies.lockScreen).toHaveBeenCalledOnce();
    await fixture.controller.stopAndRestore();
  });

  it.each(["control", "presentation", "revoked"])("privacy %s retirement restores without acquiring terminal lock authority", async (cause) => {
    const fixture = controllerFixture(); const lease = await start(fixture);
    const control = await fixture.controller.request(AUTHORITY, { op: "control", lease: lease.lease, enabled: true }) as { controlGeneration: number };
    await fixture.controller.request(AUTHORITY, { op: "privacyScreen", lease: lease.lease, controlGeneration: control.controlGeneration, enabled: true, lockOnExit: true });
    const owner = vi.mocked(fixture.dependencies.privacyScreen!).mock.calls[0]![0];
    if (cause === "revoked") { fixture.currentAuthorities.delete(authorityKey(AUTHORITY)); fixture.controller.tick(); }
    else await fixture.controller.request(AUTHORITY, { op: cause, lease: lease.lease, enabled: cause === "presentation" });
    await vi.waitFor(() => expect(fixture.dependencies.stopPrivacyScreen).toHaveBeenCalledExactlyOnceWith(owner));
    expect(fixture.dependencies.lockScreen).not.toHaveBeenCalled();
  });

  it("privacy restoration failure stays occupied and explicit retirement retries the exact owner", async () => {
    const fixture = controllerFixture(); const lease = await start(fixture);
    const control = await fixture.controller.request(AUTHORITY, { op: "control", lease: lease.lease, enabled: true }) as { controlGeneration: number };
    await fixture.controller.request(AUTHORITY, { op: "privacyScreen", lease: lease.lease, controlGeneration: control.controlGeneration, enabled: true, lockOnExit: false });
    const owner = vi.mocked(fixture.dependencies.privacyScreen!).mock.calls[0]![0];
    vi.mocked(fixture.dependencies.stopPrivacyScreen!).mockRejectedValueOnce(new Error("REMOTE_DESKTOP_PRIVACY_FAILED"));
    await expect(fixture.controller.request(AUTHORITY, { op: "stop", lease: lease.lease })).rejects.toThrowError("REMOTE_DESKTOP_PRIVACY_FAILED");
    await expect(fixture.controller.stopAndRestore()).resolves.toBeUndefined();
    expect(vi.mocked(fixture.dependencies.stopPrivacyScreen!).mock.calls.map(([captured]) => captured)).toEqual([owner, owner]);
  });

  it("awaits mute and input release before locking and blocks replacement effects", async () => {
    const fixture = controllerFixture();
    const lease = await start(fixture);
    const control = await fixture.controller.request(AUTHORITY, {
      op: "control", lease: lease.lease, enabled: true
    }) as { controlGeneration: number };
    await fixture.controller.request(AUTHORITY, {
      op: "hostMute", lease: lease.lease, controlGeneration: control.controlGeneration, enabled: true
    });
    let restore!: () => void;
    let release!: () => void;
    let lock!: () => void;
    vi.mocked(fixture.dependencies.stopHostMute!).mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => { restore = resolve; });
    });
    vi.mocked(fixture.dependencies.releaseInput!).mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => { release = resolve; });
    });
    vi.mocked(fixture.dependencies.lockScreen!).mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => { lock = resolve; });
    });
    const pending = fixture.controller.request(AUTHORITY, {
      op: "stop", lease: lease.lease, lockScreen: true, controlGeneration: control.controlGeneration
    });
    await vi.waitFor(() => expect(fixture.dependencies.stopHostMute).toHaveBeenCalledOnce());
    expect(fixture.controller.state?.controlling).toBe(false);
    expect(fixture.dependencies.releaseInput).not.toHaveBeenCalled();
    expect(fixture.dependencies.lockScreen).not.toHaveBeenCalled();
    for (const blocked of [
      { op: "start", displayId: "display-1", takeover: true },
      { op: "control", lease: lease.lease, enabled: true },
      { op: "resolution", lease: lease.lease, controlGeneration: control.controlGeneration, modeId: "101", temporary: false }
    ]) await expect(fixture.controller.request(AUTHORITY, blocked)).rejects.toThrowError("REMOTE_DESKTOP_BUSY");
    restore();
    await vi.waitFor(() => expect(fixture.dependencies.releaseInput).toHaveBeenCalledOnce());
    expect(fixture.dependencies.lockScreen).not.toHaveBeenCalled();
    release();
    await vi.waitFor(() => expect(fixture.dependencies.lockScreen).toHaveBeenCalledOnce());
    lock();
    await expect(pending).resolves.toEqual({ ok: true });
    expect(fixture.controller.state).toBeUndefined();
  });

  it("ends a failed lock occurrence and rejects replay against its ended lease", async () => {
    const fixture = controllerFixture();
    const lease = await start(fixture);
    vi.mocked(fixture.dependencies.lockScreen!).mockRejectedValueOnce(new Error("REMOTE_DESKTOP_LOCK_FAILED"));
    const exit = { op: "stop", lease: lease.lease, lockScreen: true, controlGeneration: lease.controlGeneration };
    await expect(fixture.controller.request(AUTHORITY, exit)).rejects.toThrowError("REMOTE_DESKTOP_LOCK_FAILED");
    expect(fixture.controller.state).toBeUndefined();
    const next = await start(fixture);
    await expect(fixture.controller.request(AUTHORITY, exit)).rejects.toThrowError("REMOTE_DESKTOP_LOCK_EXPIRED");
    expect(fixture.controller.state?.lease).toBe(next.lease);
    expect(fixture.dependencies.lockScreen).toHaveBeenCalledOnce();
  });

  it("never locks after revocation during input release", async () => {
    const fixture = controllerFixture();
    const lease = await start(fixture);
    let release!: () => void;
    vi.mocked(fixture.dependencies.releaseInput!).mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => { release = resolve; });
    });
    const pending = fixture.controller.request(AUTHORITY, {
      op: "stop", lease: lease.lease, lockScreen: true, controlGeneration: lease.controlGeneration
    });
    const outcome = expect(pending).rejects.toThrowError("REMOTE_DESKTOP_LOCK_EXPIRED");
    await vi.waitFor(() => expect(fixture.dependencies.releaseInput).toHaveBeenCalledOnce());
    fixture.currentAuthorities.delete(authorityKey(AUTHORITY));
    fixture.controller.tick();
    release();
    await outcome;
    expect(fixture.dependencies.lockScreen).not.toHaveBeenCalled();
    expect(fixture.controller.state).toBeUndefined();
  });

  it.each(["stop", "expiry", "revoke", "retire"])("cancels an in-flight native lock on %s", async (cause) => {
    const fixture = controllerFixture();
    const lease = await start(fixture);
    let cancellation!: AbortSignal;
    vi.mocked(fixture.dependencies.lockScreen!).mockImplementationOnce(async (_current, signal) => {
      cancellation = signal;
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("native cancelled")), { once: true });
      });
    });
    const pending = fixture.controller.request(AUTHORITY, {
      op: "stop", lease: lease.lease, lockScreen: true, controlGeneration: lease.controlGeneration
    });
    const outcome = expect(pending).rejects.toThrowError("REMOTE_DESKTOP_LOCK_EXPIRED");
    await vi.waitFor(() => expect(fixture.dependencies.lockScreen).toHaveBeenCalledOnce());
    fixture.controller.stop(OTHER_AUTHORITY);
    expect(cancellation.aborted).toBe(false);
    if (cause === "stop") fixture.controller.stop(AUTHORITY);
    else if (cause === "retire") await fixture.controller.stopAndRestore();
    else {
      if (cause === "expiry") fixture.now += REMOTE_DESKTOP_LEASE_MS + 1;
      else fixture.currentAuthorities.delete(authorityKey(AUTHORITY));
      fixture.controller.tick();
    }
    await outcome;
    expect(cancellation.aborted).toBe(true);
    expect(fixture.controller.state).toBeUndefined();
    await expect(fixture.controller.request(OTHER_AUTHORITY, { op: "start", displayId: "display-1" })).resolves.toBeDefined();
  });
});

describe("control-owned system actions", () => {
  it("requires current-v1 bounded actions and supported capability combinations", () => {
    const request = { op: "systemAction", lease: "lease-1", controlGeneration: 1, action: "workspaceLeft" };
    expect(parseRemoteDesktopRequest(request)).toEqual(request);
    for (const invalid of [{ ...request, action: "desktop" }, { ...request, controlGeneration: 0 }, { ...request, displayId: "other" }]) {
      expect(() => parseRemoteDesktopRequest(invalid)).toThrow();
    }
    const linux = { ...CAPABILITIES, platform: "linux", workspaceNavigation: true, systemMenu: true };
    expect(parseRemoteDesktopHostCapabilities(linux)).toMatchObject({ workspaceNavigation: true, systemMenu: true });
    for (const invalid of [{ ...linux, platform: "darwin" }, { ...linux, canControl: false }, { ...linux, workspaceNavigation: false },
      { ...linux, systemMenu: undefined }]) expect(() => parseRemoteDesktopHostCapabilities(invalid)).toThrow();
  });

  it("serializes effects on the leased display, preserves viewing on failure and allows explicit retry", async () => {
    const fixture = controllerFixture();
    vi.mocked(fixture.dependencies.capabilities).mockResolvedValue({ ...CAPABILITIES, platform: "linux", workspaceNavigation: true, systemMenu: true });
    let complete!: () => void;
    vi.mocked(fixture.dependencies.workspaceAction!).mockImplementationOnce(async () => new Promise<void>(resolve => { complete = resolve; }));
    const lease = await start(fixture);
    await fixture.controller.request(AUTHORITY, { op: "control", lease: lease.lease, enabled: true });
    const request = { op: "systemAction", lease: lease.lease, controlGeneration: fixture.controller.state!.controlGeneration, action: "workspaceLeft" };
    const first = fixture.controller.request(AUTHORITY, request);
    await vi.waitFor(() => expect(fixture.dependencies.workspaceAction).toHaveBeenCalledOnce());
    const second = fixture.controller.request(AUTHORITY, { ...request, action: "workspaceRight" });
    expect(fixture.dependencies.workspaceAction).toHaveBeenCalledTimes(1);
    complete(); await expect(first).resolves.toEqual({ action: "workspaceLeft" }); await second;
    expect(vi.mocked(fixture.dependencies.workspaceAction!).mock.calls[1]?.slice(0, 2)).toEqual(["workspaceRight", "display-1"]);
    vi.mocked(fixture.dependencies.workspaceAction!).mockRejectedValueOnce(new Error("REMOTE_DESKTOP_SYSTEM_ACTION_UNAVAILABLE"));
    await expect(fixture.controller.request(AUTHORITY, { ...request, action: "systemMenu" })).rejects.toThrow("REMOTE_DESKTOP_SYSTEM_ACTION_UNAVAILABLE");
    expect(fixture.controller.state).toMatchObject({ lease: lease.lease, controlling: true });
    await expect(fixture.controller.request(AUTHORITY, { ...request, action: "systemMenu" })).resolves.toEqual({ action: "systemMenu" });
  });

  it("retires queued effects and joins actual in-flight close before stop or replacement control", async () => {
    const fixture = controllerFixture();
    vi.mocked(fixture.dependencies.capabilities).mockResolvedValue({ ...CAPABILITIES, platform: "linux", workspaceNavigation: true, systemMenu: false });
    const lease = await start(fixture); await fixture.controller.request(AUTHORITY, { op: "control", lease: lease.lease, enabled: true });
    let finish!: () => void; let close!: () => void;
    vi.mocked(fixture.dependencies.workspaceAction!).mockImplementationOnce(async () => new Promise<void>(resolve => { finish = resolve; }));
    const request = { op: "systemAction", lease: lease.lease, controlGeneration: fixture.controller.state!.controlGeneration, action: "workspaceLeft" };
    const first = expect(fixture.controller.request(AUTHORITY, request)).rejects.toThrow("REMOTE_DESKTOP_SYSTEM_ACTION_EXPIRED");
    await vi.waitFor(() => expect(fixture.dependencies.workspaceAction).toHaveBeenCalledOnce());
    const queued = expect(fixture.controller.request(AUTHORITY, { ...request, action: "workspaceRight" })).rejects.toThrow("REMOTE_DESKTOP_SYSTEM_ACTION_EXPIRED");
    vi.mocked(fixture.dependencies.stopWorkspaceActions!).mockImplementationOnce(async () => new Promise<void>(resolve => { close = resolve; }));
    let stopped = false;
    const stop = fixture.controller.stopAndRestore().then(() => { stopped = true; });
    finish(); await first; await queued; await Promise.resolve();
    expect(stopped).toBe(false); expect(fixture.dependencies.workspaceAction).toHaveBeenCalledTimes(1);
    close(); await stop; expect(stopped).toBe(true);
    await expect(fixture.controller.request(AUTHORITY, request)).rejects.toThrow("REMOTE_DESKTOP_SYSTEM_ACTION_EXPIRED");
  });
});

describe("temporary display modes and captured restoration", () => {
  async function controlled(fixture: ReturnType<typeof controllerFixture>) {
    const lease = await start(fixture);
    const control = await fixture.controller.request(AUTHORITY, { op: "control", lease: lease.lease, enabled: true }) as { readonly controlGeneration: number };
    return { lease, control };
  }
  function actualModes(fixture: ReturnType<typeof controllerFixture>) {
    vi.mocked(fixture.dependencies.setDisplayMode!).mockImplementation(async (id, mode, beforeChange) => {
      await beforeChange();
      const selected = (await fixture.dependencies.displayModes!(id, AUTHORITY)).find((item) => item.id === mode)!;
      return { id, name: "Built-in Display", width: selected.width, height: selected.height };
    });
  }
  it("uses Linux host modes for a temporary same-lease change and restores the captured original on stop", async () => {
    const fixture = controllerFixture(); actualModes(fixture);
    vi.mocked(fixture.dependencies.capabilities).mockResolvedValue({ ...CAPABILITIES, platform: "linux",
      hostMute: false, lockOnExit: false, privacyScreen: false, nativeCredentials: false });
    const { lease, control } = await controlled(fixture);
    await expect(fixture.controller.request(AUTHORITY, { op: "displayModes", lease: lease.lease }))
      .resolves.toMatchObject([{ id: "101", current: true }, { id: "102", current: false }]);
    const result = await fixture.controller.request(AUTHORITY, { op: "resolution", lease: lease.lease,
      controlGeneration: control.controlGeneration, modeId: "102", temporary: true }) as { lease: RemoteDesktopLease };
    expect(result.lease).toMatchObject({ lease: lease.lease, controlling: false, display: { width: 1_024, height: 640 } });
    expect(result.lease.controlGeneration).toBeGreaterThan(control.controlGeneration);
    await fixture.controller.request(AUTHORITY, { op: "stop", lease: lease.lease });
    expect(fixture.dependencies.restoreDisplayMode).toHaveBeenCalledExactlyOnceWith("display-1", "101",
      expect.any(Function), expect.objectContaining({ width: 1_280, height: 800 }), expect.objectContaining(AUTHORITY));
    expect(fixture.controller.state).toBeUndefined();
  });
  it("temporary modes retain the same lease, rotate control and restore the first original after repeated changes", async () => {
    const fixture = controllerFixture(); actualModes(fixture);
    const { lease, control } = await controlled(fixture);
    await fixture.controller.request(AUTHORITY, { op: "hostMute", lease: lease.lease,
      controlGeneration: control.controlGeneration, enabled: true });
    await fixture.controller.request(AUTHORITY, { op: "privacyScreen", lease: lease.lease,
      controlGeneration: control.controlGeneration, enabled: true, lockOnExit: false });
    const first = await fixture.controller.request(AUTHORITY, { op: "resolution", lease: lease.lease,
      controlGeneration: control.controlGeneration, modeId: "102", temporary: true }) as { lease: RemoteDesktopLease };
    expect(first.lease).toMatchObject({ lease: lease.lease, controlling: false, display: { width: 1_024, height: 640 } });
    expect(first.lease.controlGeneration).toBeGreaterThan(control.controlGeneration);
    expect(fixture.dependencies.stopHostMute).toHaveBeenCalledOnce();
    expect(fixture.dependencies.stopPrivacyScreen).toHaveBeenCalledOnce();
    expect(fixture.dependencies.releaseInput).toHaveBeenCalledOnce();
    expect(fixture.controller.displayGeometryMatches("display-1", 1_024, 640)).toBe(true);
    vi.mocked(fixture.dependencies.displayModes!).mockResolvedValueOnce([
      { id: "101", width: 1_280, height: 800, current: false, native: true },
      { id: "102", width: 1_024, height: 640, current: true, native: false }
    ]);
    const next = await fixture.controller.request(AUTHORITY, { op: "control", lease: lease.lease, enabled: true }) as { controlGeneration: number };
    await fixture.controller.request(AUTHORITY, { op: "resolution", lease: lease.lease,
      controlGeneration: next.controlGeneration, modeId: "101", temporary: true });
    await fixture.controller.stopAndRestore();
    expect(fixture.dependencies.restoreDisplayMode).toHaveBeenCalledExactlyOnceWith("display-1", "101",
      expect.any(Function), expect.objectContaining({ width: 1_280, height: 800 }), expect.objectContaining(AUTHORITY));
  });
  it("temporary stop waits an in-flight native effect and restores before replacement can start", async () => {
    const fixture = controllerFixture(); const { lease, control } = await controlled(fixture);
    let complete!: (display: RemoteDesktopLease["display"]) => void;
    let nativeCurrent!: () => boolean;
    vi.mocked(fixture.dependencies.setDisplayMode!).mockImplementationOnce(async (_id, _mode, beforeChange, _authority, expected) => {
      await beforeChange(); nativeCurrent = expected!.current!;
      return new Promise((resolve) => { complete = resolve; });
    });
    const pending = fixture.controller.request(AUTHORITY, { op: "resolution", lease: lease.lease,
      controlGeneration: control.controlGeneration, modeId: "102", temporary: true });
    const outcome = expect(pending).rejects.toThrowError("REMOTE_DESKTOP_LEASE_EXPIRED");
    await vi.waitFor(() => expect(complete).toBeTypeOf("function"));
    expect(nativeCurrent()).toBe(true);
    expect(fixture.controller.isControlCurrent(AUTHORITY, lease.lease, control.controlGeneration)).toBe(false);
    expect(() => fixture.controller.input(AUTHORITY, lease.lease, 1, [{ kind: "release" }])).toThrowError("REMOTE_DESKTOP_DISPLAY_BUSY");
    let ended = false; const ending = fixture.controller.stopAndRestore().then(() => { ended = true; });
    expect(nativeCurrent()).toBe(false);
    await Promise.resolve(); expect(ended).toBe(false);
    expect(fixture.dependencies.restoreDisplayMode).not.toHaveBeenCalled();
    await expect(start(fixture)).rejects.toThrowError("REMOTE_DESKTOP_DISPLAY_BUSY");
    complete({ id: "display-1", name: "Display", width: 1_024, height: 640 });
    await outcome; await ending;
    expect(fixture.dependencies.restoreDisplayMode).toHaveBeenCalledOnce();
    await expect(start(fixture)).resolves.toBeDefined();
  });
  it("temporary restoration rejection keeps the original snapshot and blocks start until an explicit retry succeeds", async () => {
    const fixture = controllerFixture(); actualModes(fixture);
    const { lease, control } = await controlled(fixture);
    await fixture.controller.request(AUTHORITY, { op: "resolution", lease: lease.lease,
      controlGeneration: control.controlGeneration, modeId: "102", temporary: true });
    vi.mocked(fixture.dependencies.restoreDisplayMode!).mockRejectedValueOnce(new Error("native restore rejected"))
      .mockRejectedValueOnce(new Error("native restore still rejected"));
    await expect(fixture.controller.stopAndRestore()).rejects.toThrowError("REMOTE_DESKTOP_DISPLAY_RESTORE_UNAVAILABLE");
    await expect(start(fixture)).rejects.toThrowError("REMOTE_DESKTOP_DISPLAY_RESTORE_UNAVAILABLE");
    expect(fixture.controller.state).toBeUndefined();
    await expect(start(fixture)).resolves.toBeDefined();
    expect(fixture.dependencies.restoreDisplayMode).toHaveBeenCalledTimes(3);
  });
  it("temporary takeover joins captured restoration and old cleanup cannot touch the replacement", async () => {
    const fixture = controllerFixture(); actualModes(fixture);
    const { lease, control } = await controlled(fixture);
    await fixture.controller.request(AUTHORITY, { op: "resolution", lease: lease.lease,
      controlGeneration: control.controlGeneration, modeId: "102", temporary: true });
    let restored!: () => void;
    vi.mocked(fixture.dependencies.restoreDisplayMode!).mockImplementationOnce(() => new Promise((resolve) => { restored = resolve; }));
    const replacement = fixture.controller.request(OTHER_AUTHORITY, { op: "start", displayId: "display-1", takeover: true });
    await vi.waitFor(() => expect(restored).toBeTypeOf("function"));
    expect(fixture.controller.state).toBeUndefined(); restored();
    await replacement;
    fixture.controller.stop(AUTHORITY);
    expect(fixture.controller.state?.controllerDeviceId).toBe(OTHER_AUTHORITY.controllerDeviceId);
    expect(fixture.dependencies.restoreDisplayMode).toHaveBeenCalledOnce();
  });
  it("temporary restoration retires an unplugged captured physical display without writing another display", async () => {
    const fixture = controllerFixture(); actualModes(fixture);
    const { lease, control } = await controlled(fixture);
    await fixture.controller.request(AUTHORITY, { op: "resolution", lease: lease.lease,
      controlGeneration: control.controlGeneration, modeId: "102", temporary: true });
    vi.mocked(fixture.dependencies.displayPresent!).mockResolvedValueOnce(false);
    await fixture.controller.stopAndRestore();
    expect(fixture.dependencies.restoreDisplayMode).not.toHaveBeenCalled();
  });
  it("temporary geometry rejects an old asynchronous frame without retiring the updated same lease", async () => {
    const fixture = controllerFixture(); actualModes(fixture);
    const { lease, control } = await controlled(fixture);
    let frameReady!: (frame: { jpeg: string; width: number; height: number }) => void;
    vi.mocked(fixture.dependencies.frame).mockImplementationOnce(() => new Promise((resolve) => { frameReady = resolve; }));
    const frame = fixture.controller.request(AUTHORITY, { op: "frame", lease: lease.lease, cursorOverlay: false });
    const outcome = expect(frame).rejects.toThrowError("REMOTE_DESKTOP_LEASE_EXPIRED");
    await vi.waitFor(() => expect(frameReady).toBeTypeOf("function"));
    await fixture.controller.request(AUTHORITY, { op: "resolution", lease: lease.lease,
      controlGeneration: control.controlGeneration, modeId: "102", temporary: true });
    frameReady({ jpeg: "YWJj", width: 3, height: 1 }); await outcome;
    expect(fixture.controller.state).toMatchObject({ lease: lease.lease, controlling: false });
    await fixture.controller.stopAndRestore();
  });
  it("temporary mode followed by permanent mode restores the captured original before the permanent write", async () => {
    const fixture = controllerFixture(); actualModes(fixture);
    const { lease, control } = await controlled(fixture);
    await fixture.controller.request(AUTHORITY, { op: "resolution", lease: lease.lease,
      controlGeneration: control.controlGeneration, modeId: "102", temporary: true });
    const next = await fixture.controller.request(AUTHORITY, { op: "control", lease: lease.lease, enabled: true }) as { controlGeneration: number };
    await fixture.controller.request(AUTHORITY, { op: "resolution", lease: lease.lease,
      controlGeneration: next.controlGeneration, modeId: "102", temporary: false });
    expect(fixture.dependencies.restoreDisplayMode).toHaveBeenCalledOnce();
    expect(vi.mocked(fixture.dependencies.restoreDisplayMode!).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(fixture.dependencies.setDisplayMode!).mock.invocationCallOrder[1]!);
    expect(fixture.controller.state).toBeUndefined();
    await fixture.controller.stopAndRestore();
    expect(fixture.dependencies.restoreDisplayMode).toHaveBeenCalledOnce();
  });
  it.each(["native-error", "geometry-mismatch"])("temporary %s after native dispatch reports a terminal reason and restores", async (kind) => {
    const fixture = controllerFixture(); const { lease, control } = await controlled(fixture);
    vi.mocked(fixture.dependencies.setDisplayMode!).mockImplementationOnce(async (_id, _mode, beforeChange) => {
      await beforeChange();
      if (kind === "native-error") throw new Error("REMOTE_DESKTOP_DISPLAY_MODES_UNAVAILABLE");
      return { id: "display-1", name: "Display", width: 1_280, height: 800 };
    });
    await expect(fixture.controller.request(AUTHORITY, { op: "resolution", lease: lease.lease,
      controlGeneration: control.controlGeneration, modeId: "102", temporary: true }))
      .rejects.toThrowError("REMOTE_DESKTOP_LEASE_EXPIRED");
    expect(fixture.controller.state).toBeUndefined();
    await fixture.controller.stopAndRestore();
    expect(fixture.dependencies.restoreDisplayMode).toHaveBeenCalledExactlyOnceWith("display-1", "101",
      expect.any(Function), expect.objectContaining({ width: 1_280, height: 800 }), expect.objectContaining(AUTHORITY));
  });
});

describe("managed viewer display ownership", () => {
  function viewerFixture(platform: "linux" | "darwin" = "linux") {
    const fixture = controllerFixture();
    const source = CAPABILITIES.displays[0]!;
    const handle = {
      displayId: "mirror-1",
      resize: vi.fn(async (width: number, height: number, current: () => boolean) => {
        if (!current()) throw new Error("REMOTE_DESKTOP_LEASE_EXPIRED");
        return { id: "mirror-1", name: "Viewer", width, height };
      }),
      restore: vi.fn(async (current: () => boolean) => {
        if (!current()) throw new Error("REMOTE_DESKTOP_LEASE_EXPIRED");
        return source;
      }),
      dispose: vi.fn()
    };
    fixture.dependencies.createViewerDisplay = vi.fn<NonNullable<RemoteDesktopControllerDependencies["createViewerDisplay"]>>(async () => handle);
    vi.mocked(fixture.dependencies.capabilities).mockResolvedValue({ ...CAPABILITIES, platform,
      hostMute: false, lockOnExit: false, privacyScreen: false, nativeCredentials: false,
      viewerDisplay: true, viewerDisplayRestore: true });
    return { ...fixture, handle, source };
  }
  async function takeControl(fixture: ReturnType<typeof viewerFixture>, lease: RemoteDesktopLease) {
    return fixture.controller.request(AUTHORITY, { op: "control", lease: lease.lease, enabled: true }) as Promise<{ controlGeneration: number }>;
  }
  async function fit(fixture: ReturnType<typeof viewerFixture>, lease: RemoteDesktopLease, generation: number, width = 1280, height = 720) {
    return fixture.controller.request(AUTHORITY, { op: "viewerDisplay", lease: lease.lease,
      controlGeneration: generation, width, height }) as Promise<{ lease: RemoteDesktopLease }>;
  }

  it.each([[1, 1], [16, 9], [640, 360], [1280, 721], [4096, 2304]])(
    "adopts Mac adjusted logical Fit %s x %s on the captured same lease", async (width, height) => {
      const fixture = viewerFixture("darwin"); const lease = await start(fixture); const control = await takeControl(fixture, lease);
      fixture.handle.resize.mockResolvedValueOnce({ id: "mirror-1", name: "Viewer", width, height });
      const result = await fit(fixture, lease, control.controlGeneration);
      expect(result.lease).toMatchObject({ lease: lease.lease, controlling: false, display: { id: "mirror-1", width, height } });
      expect(result.lease.controlGeneration).toBeGreaterThan(control.controlGeneration);
      expect(fixture.controller.state?.sourceDisplayId).toBe("display-1");
      expect(fixture.controller.displayGeometryMatches("mirror-1", width, height)).toBe(true);
      expect(fixture.dependencies.stopInput).toHaveBeenCalled(); expect(fixture.dependencies.stopVideo).toHaveBeenCalled();
      await fixture.controller.stopAndRestore(); expect(fixture.handle.restore).toHaveBeenCalledOnce();
    });

  it.each([
    { platform: "linux" as const, width: 640, height: 360 },
    { platform: "darwin" as const, width: 0, height: 0 },
    { platform: "darwin" as const, width: 4097, height: 2304 },
    { platform: "darwin" as const, width: 640.5, height: 360 },
    { platform: "darwin" as const, width: 1280, height: 722 }
  ])("rejects $platform invalid Fit $width x $height and joins owned cleanup", async ({ platform, width, height }) => {
    const fixture = viewerFixture(platform); const lease = await start(fixture); const control = await takeControl(fixture, lease);
    fixture.handle.resize.mockResolvedValueOnce({ id: "mirror-1", name: "Viewer", width, height });
    await expect(fit(fixture, lease, control.controlGeneration)).rejects.toThrow("REMOTE_DESKTOP_LEASE_EXPIRED");
    expect(fixture.controller.state).toBeUndefined(); await fixture.controller.stopAndRestore();
    expect(fixture.handle.restore).toHaveBeenCalledOnce(); expect(fixture.controller.managedViewerDisplay).toBeUndefined();
  });

  it("rejects a replacement Mac mirror ID during repeated Fit and retains failed cleanup responsibility", async () => {
    const fixture = viewerFixture("darwin"); const lease = await start(fixture); const control = await takeControl(fixture, lease);
    const fitted = await fit(fixture, lease, control.controlGeneration); const next = await takeControl(fixture, fitted.lease);
    fixture.handle.resize.mockImplementationOnce(async () => {
      fixture.handle.displayId = "mirror-2"; return { id: "mirror-2", name: "Viewer", width: 640, height: 360 };
    });
    fixture.handle.restore.mockRejectedValueOnce(new Error("still owned"));
    await expect(fit(fixture, lease, next.controlGeneration)).rejects.toThrow("REMOTE_DESKTOP_LEASE_EXPIRED");
    await vi.waitFor(() => expect(fixture.handle.restore).toHaveBeenCalledOnce());
    expect(fixture.controller.managedViewerDisplay).toMatchObject({ sourceDisplayId: "display-1", displayId: "mirror-2" });
    await fixture.controller.stopAndRestore(); expect(fixture.controller.managedViewerDisplay).toBeUndefined();
  });

  it("filters only the exact owned mirror ID while preserving physical source and same-name displays", async () => {
    const fixture = viewerFixture("darwin"); const lease = await start(fixture); const control = await takeControl(fixture, lease);
    const fitted = await fit(fixture, lease, control.controlGeneration);
    const capabilities = await fixture.dependencies.capabilities(AUTHORITY);
    const mirror = { id: "mirror-1", name: "Viewer", width: 1280, height: 720 };
    const unowned = { ...mirror, id: "mirror-unowned" };
    vi.mocked(fixture.dependencies.capabilities).mockResolvedValue({ ...capabilities, displays: [fixture.source, mirror, unowned] });
    const result = await fixture.controller.request(AUTHORITY, { op: "capabilities" }) as { displays: readonly unknown[] };
    expect(result.displays).toEqual([fixture.source, unowned]);
    const next = await takeControl(fixture, fitted.lease);
    await fixture.controller.request(AUTHORITY, { op: "restoreViewerDisplay", lease: lease.lease, controlGeneration: next.controlGeneration });
    expect((await fixture.controller.request(AUTHORITY, { op: "capabilities" }) as { displays: readonly unknown[] }).displays)
      .toEqual([fixture.source, mirror, unowned]);
    await fixture.controller.stopAndRestore();
  });

  it.each(["created", "restored", "cycled"])("rejects a late directory when managed ownership was %s during the read", async change => {
    const fixture = viewerFixture("darwin"); const lease = await start(fixture); let control = await takeControl(fixture, lease);
    if (change === "restored") {
      const fitted = await fit(fixture, lease, control.controlGeneration); control = await takeControl(fixture, fitted.lease);
    }
    const capabilities = await fixture.dependencies.capabilities(AUTHORITY);
    let finish!: (value: RemoteDesktopHostCapabilities) => void;
    vi.mocked(fixture.dependencies.capabilities).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const reading = fixture.controller.request(AUTHORITY, { op: "capabilities" });
    const rejected = expect(reading).rejects.toThrow("REMOTE_DESKTOP_DISPLAY_BUSY");
    if (change !== "restored") {
      const fitted = await fit(fixture, lease, control.controlGeneration); control = await takeControl(fixture, fitted.lease);
    }
    if (change !== "created") await fixture.controller.request(AUTHORITY, { op: "restoreViewerDisplay", lease: lease.lease,
      controlGeneration: control.controlGeneration });
    finish(capabilities); await rejected; await fixture.controller.stopAndRestore();
  });

  it.each(["mirror", "physical"])("pre-lease preparation waits for actual %s restoration before loading a host effect", async target => {
    const fixture = viewerFixture(); const lease = await start(fixture); const control = await takeControl(fixture, lease);
    if (target === "mirror") await fit(fixture, lease, control.controlGeneration);
    else {
      vi.mocked(fixture.dependencies.setDisplayMode!).mockImplementationOnce(async (id, _mode, beforeChange) => {
        await beforeChange(); return { id, name: "Display", width: 1024, height: 640 };
      });
      await fixture.controller.request(AUTHORITY, { op: "resolution", lease: lease.lease,
        controlGeneration: control.controlGeneration, modeId: "102", temporary: true });
    }
    const prepare = fixture.dependencies.prepare = vi.fn(async (current: () => boolean) => {
      expect(fixture.controller.state).toBeUndefined();
      expect(fixture.controller.managedViewerDisplay).toBeUndefined(); expect(current()).toBe(true);
    });
    let restored!: () => void;
    if (target === "mirror") fixture.handle.restore.mockImplementationOnce(async current => {
      await new Promise<void>(resolve => { restored = resolve; }); expect(current()).toBe(true); return fixture.source;
    });
    else vi.mocked(fixture.dependencies.restoreDisplayMode!).mockImplementationOnce(async (_id, _mode, current) => {
      await new Promise<void>(resolve => { restored = resolve; }); expect(current()).toBe(true); return fixture.source;
    });
    const pending = fixture.controller.request(AUTHORITY, { op: "start", displayId: "display-1", resume: true });
    await vi.waitFor(() => expect(restored).toBeTypeOf("function"));
    expect(prepare).not.toHaveBeenCalled(); restored();
    await expect(pending).resolves.toMatchObject({ display: fixture.source, controlling: false });
    expect(prepare).toHaveBeenCalledOnce(); await fixture.controller.stopAndRestore();
  });

  it.each(["failed", "retired"])("pre-lease preparation cannot publish a %s initialization receipt", async condition => {
    const fixture = viewerFixture(); let finish!: () => void; let valid!: () => boolean;
    fixture.dependencies.prepare = vi.fn(async (current: () => boolean) => {
      valid = current; await new Promise<void>(resolve => { finish = resolve; });
      if (condition === "failed") throw new Error("REMOTE_DESKTOP_PRIVACY_UNAVAILABLE");
    });
    const pending = fixture.controller.request(AUTHORITY, { op: "start", displayId: "display-1" });
    const rejected = expect(pending).rejects.toThrow(condition === "failed"
      ? "REMOTE_DESKTOP_PRIVACY_UNAVAILABLE" : "REMOTE_DESKTOP_LEASE_EXPIRED");
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    expect(valid()).toBe(true);
    if (condition === "retired") { fixture.controller.stopByUser(); expect(valid()).toBe(false); }
    finish(); await rejected; expect(fixture.controller.state).toBeUndefined();
  });

  it("reuses one mirror for repeated Fit and returns to the physical source with fresh view-only authority", async () => {
    const fixture = viewerFixture(); const lease = await start(fixture); const control = await takeControl(fixture, lease);
    const first = await fit(fixture, lease, control.controlGeneration);
    expect(first.lease).toMatchObject({ lease: lease.lease, controlling: false, display: { id: "mirror-1", width: 1280, height: 720 } });
    expect(first.lease.controlGeneration).toBeGreaterThan(control.controlGeneration);
    expect(vi.mocked(fixture.dependencies.createViewerDisplay!).mock.calls[0]![1]()).toBe(true);
    expect(fixture.controller.state).toMatchObject({ sourceDisplayId: "display-1", displayId: "mirror-1" });
    expect(fixture.controller.managedViewerDisplay).toEqual({ sourceDisplayId: "display-1", displayId: "mirror-1" });
    expect(fixture.dependencies.releaseInput).toHaveBeenCalledOnce();
    await fixture.controller.request(AUTHORITY, { op: "displayModes", lease: lease.lease });
    expect(fixture.dependencies.displayModes).toHaveBeenLastCalledWith("display-1", AUTHORITY);
    const next = await takeControl(fixture, first.lease);
    expect(fixture.dependencies.startInput).toHaveBeenLastCalledWith("mirror-1", AUTHORITY);
    const second = await fit(fixture, lease, next.controlGeneration, 800, 600);
    expect(fixture.dependencies.createViewerDisplay).toHaveBeenCalledOnce(); expect(fixture.handle.resize).toHaveBeenCalledTimes(2);
    const restoredControl = await takeControl(fixture, second.lease);
    const restored = await fixture.controller.request(AUTHORITY, { op: "restoreViewerDisplay", lease: lease.lease,
      controlGeneration: restoredControl.controlGeneration }) as { lease: RemoteDesktopLease };
    expect(restored.lease).toMatchObject({ lease: lease.lease, controlling: false, display: fixture.source });
    expect(restored.lease.controlGeneration).toBeGreaterThan(restoredControl.controlGeneration);
    expect(fixture.controller.managedViewerDisplay).toBeUndefined();
    await fixture.controller.stopAndRestore(); expect(fixture.handle.restore).toHaveBeenCalledOnce();
  });

  it("restores the mirror before changing physical modes and retains the first physical original for stop", async () => {
    const fixture = viewerFixture(); const lease = await start(fixture); const control = await takeControl(fixture, lease);
    const fitted = await fit(fixture, lease, control.controlGeneration); const next = await takeControl(fixture, fitted.lease);
    vi.mocked(fixture.dependencies.setDisplayMode!).mockImplementation(async (id, _mode, beforeChange) => {
      await beforeChange(); return { id, name: "Display", width: 1024, height: 640 };
    });
    const changed = await fixture.controller.request(AUTHORITY, { op: "resolution", lease: lease.lease,
      controlGeneration: next.controlGeneration, modeId: "102", temporary: true }) as { lease: RemoteDesktopLease };
    expect(changed.lease.display).toMatchObject({ id: "display-1", width: 1024, height: 640 });
    expect(fixture.handle.restore.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(fixture.dependencies.displayModes!).mock.invocationCallOrder[0]!);
    expect(fixture.dependencies.setDisplayMode).toHaveBeenCalledWith("display-1", "102", expect.any(Function), AUTHORITY, expect.objectContaining({ width: 1024, height: 640 }));
    await fixture.controller.stopAndRestore();
    expect(fixture.dependencies.restoreDisplayMode).toHaveBeenCalledWith("display-1", "101", expect.any(Function),
      expect.objectContaining({ width: 1280, height: 800 }), expect.objectContaining(AUTHORITY));
  });

  it.each(["mirror", "physical original"])("joins actual %s restoration before terminal Linux lock", async target => {
    const fixture = viewerFixture();
    const capabilities = await fixture.dependencies.capabilities(AUTHORITY);
    vi.mocked(fixture.dependencies.capabilities).mockResolvedValue({ ...capabilities, lockOnExit: true });
    const lease = await start(fixture); const control = await takeControl(fixture, lease);
    let generation: number;
    if (target === "mirror") generation = (await fit(fixture, lease, control.controlGeneration)).lease.controlGeneration;
    else {
      vi.mocked(fixture.dependencies.setDisplayMode!).mockImplementationOnce(async (id, _mode, beforeChange) => {
        await beforeChange(); return { id, name: "Display", width: 1024, height: 640 };
      });
      const result = await fixture.controller.request(AUTHORITY, { op: "resolution", lease: lease.lease,
        controlGeneration: control.controlGeneration, modeId: "102", temporary: true }) as { lease: RemoteDesktopLease };
      generation = result.lease.controlGeneration;
    }
    let restored!: () => void;
    if (target === "mirror") fixture.handle.restore.mockImplementationOnce(async current => {
      await new Promise<void>(resolve => { restored = resolve; }); expect(current()).toBe(true); return fixture.source;
    });
    else vi.mocked(fixture.dependencies.restoreDisplayMode!).mockImplementationOnce(async (_id, _mode, current) => {
      await new Promise<void>(resolve => { restored = resolve; }); expect(current()).toBe(true);
    });
    vi.mocked(fixture.dependencies.lockScreen!).mockImplementationOnce(async current => {
      expect(fixture.controller.state).toMatchObject({ displayId: "display-1", sourceDisplayId: "display-1" });
      expect(fixture.controller.displayGeometryMatches("display-1", 1280, 800)).toBe(true);
      expect(fixture.controller.managedViewerDisplay).toBeUndefined();
      expect(current()).toBe(true);
    });
    const pending = fixture.controller.request(AUTHORITY, { op: "stop", lease: lease.lease,
      lockScreen: true, controlGeneration: generation });
    await vi.waitFor(() => expect(restored).toBeTypeOf("function"));
    expect(fixture.controller.state).toMatchObject({ lease: lease.lease, controlling: false });
    expect(fixture.dependencies.stopVideo).toHaveBeenCalled();
    expect(fixture.dependencies.lockScreen).not.toHaveBeenCalled();
    await expect(fixture.controller.request(AUTHORITY, { op: "start", displayId: "display-1", takeover: true }))
      .rejects.toThrowError("REMOTE_DESKTOP_BUSY");
    restored(); await expect(pending).resolves.toEqual({ ok: true });
    expect(fixture.dependencies.lockScreen).toHaveBeenCalledOnce();
    expect(fixture.controller.managedViewerDisplay).toBeUndefined();
    expect(fixture.controller.state).toBeUndefined();
  });

  it("retains failed pre-lock mirror restoration and blocks replacement without dispatching lock", async () => {
    const fixture = viewerFixture(); const capabilities = await fixture.dependencies.capabilities(AUTHORITY);
    vi.mocked(fixture.dependencies.capabilities).mockResolvedValue({ ...capabilities, lockOnExit: true });
    const lease = await start(fixture); const control = await takeControl(fixture, lease);
    const fitted = await fit(fixture, lease, control.controlGeneration);
    fixture.handle.restore.mockRejectedValueOnce(new Error("not closed")).mockRejectedValueOnce(new Error("still not closed"));
    await expect(fixture.controller.request(AUTHORITY, { op: "stop", lease: lease.lease,
      lockScreen: true, controlGeneration: fitted.lease.controlGeneration })).rejects.toThrowError("REMOTE_DESKTOP_DISPLAY_RESTORE_UNAVAILABLE");
    expect(fixture.dependencies.lockScreen).not.toHaveBeenCalled();
    expect(fixture.controller.state).toBeUndefined();
    expect(fixture.controller.managedViewerDisplay).toEqual({ sourceDisplayId: "display-1", displayId: "mirror-1" });
    fixture.handle.restore.mockRejectedValueOnce(new Error("still owned"));
    await expect(start(fixture)).rejects.toThrowError("REMOTE_DESKTOP_DISPLAY_RESTORE_UNAVAILABLE");
    await expect(start(fixture)).resolves.toMatchObject({ display: fixture.source });
    expect(fixture.controller.managedViewerDisplay).toBeUndefined();
  });

  it.each(["create", "resize"])("joins an in-flight mirror %s before cleanup and rejects its late receipt", async stage => {
    const fixture = viewerFixture(); const lease = await start(fixture); const control = await takeControl(fixture, lease);
    let finish!: () => void;
    if (stage === "create") vi.mocked(fixture.dependencies.createViewerDisplay!).mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve(fixture.handle); }));
    else fixture.handle.resize.mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve({ id: "mirror-1", name: "Viewer", width: 1280, height: 720 }); }));
    const pending = fit(fixture, lease, control.controlGeneration); const outcome = expect(pending).rejects.toThrowError("REMOTE_DESKTOP_LEASE_EXPIRED");
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    let ended = false; const ending = fixture.controller.stopAndRestore().then(() => { ended = true; });
    await Promise.resolve(); expect(ended).toBe(false); expect(fixture.handle.restore).not.toHaveBeenCalled();
    expect(fixture.controller.managedViewerDisplay?.sourceDisplayId).toBe("display-1");
    await expect(start(fixture)).rejects.toThrowError("REMOTE_DESKTOP_DISPLAY_BUSY");
    finish(); await outcome; await ending;
    expect(fixture.handle.dispose).toHaveBeenCalledOnce(); expect(fixture.handle.restore).toHaveBeenCalledOnce();
    expect(fixture.controller.managedViewerDisplay).toBeUndefined();
    const replacement = await start(fixture);
    vi.mocked(fixture.dependencies.createViewerDisplay!).mock.calls[0]![2]();
    expect(fixture.controller.state?.lease).toBe(replacement.lease);
  });

  it("retains failed mirror restoration and blocks replacement until actual release succeeds", async () => {
    const fixture = viewerFixture(); const lease = await start(fixture); const control = await takeControl(fixture, lease);
    await fit(fixture, lease, control.controlGeneration);
    fixture.handle.restore.mockRejectedValueOnce(new Error("not closed")).mockRejectedValueOnce(new Error("still not closed"));
    await expect(fixture.controller.stopAndRestore()).rejects.toThrowError("REMOTE_DESKTOP_DISPLAY_RESTORE_UNAVAILABLE");
    expect(fixture.controller.managedViewerDisplay).toEqual({ sourceDisplayId: "display-1", displayId: "mirror-1" });
    await expect(start(fixture)).rejects.toThrowError("REMOTE_DESKTOP_DISPLAY_RESTORE_UNAVAILABLE");
    await expect(start(fixture)).resolves.toMatchObject({ display: fixture.source });
    expect(fixture.controller.managedViewerDisplay).toBeUndefined(); expect(fixture.handle.restore).toHaveBeenCalledTimes(3);
  });

  it.each(["resume", "takeover"])("joins mirror restoration before a physical-source %s can replace its capture lease", async operation => {
    const fixture = viewerFixture(); const lease = await start(fixture); const control = await takeControl(fixture, lease);
    await fit(fixture, lease, control.controlGeneration);
    let restored!: () => void;
    fixture.handle.restore.mockImplementationOnce(() => new Promise(resolve => { restored = () => resolve(fixture.source); }));
    const authority = operation === "resume" ? AUTHORITY : OTHER_AUTHORITY;
    const replacement = fixture.controller.request(authority, { op: "start", displayId: "display-1",
      ...(operation === "resume" ? { resume: true } : { takeover: true }) }) as Promise<RemoteDesktopLease>;
    await vi.waitFor(() => expect(restored).toBeTypeOf("function"));
    expect(fixture.controller.state).toBeUndefined();
    expect(fixture.controller.managedViewerDisplay).toEqual({ sourceDisplayId: "display-1", displayId: "mirror-1" });
    restored(); const next = await replacement;
    expect(next).toMatchObject({ display: fixture.source, controlling: false }); expect(next.lease).not.toBe(lease.lease);
    expect(fixture.controller.state?.controllerDeviceId).toBe(authority.controllerDeviceId);
    expect(fixture.controller.managedViewerDisplay).toBeUndefined();
    vi.mocked(fixture.dependencies.createViewerDisplay!).mock.calls[0]![2]();
    expect(fixture.controller.state?.lease).toBe(next.lease);
  });
});

function controllerFixture() {
  const currentAuthorities = new Set([authorityKey(AUTHORITY), authorityKey(OTHER_AUTHORITY)]);
  let leaseSequence = 0;
  const clock = { now: 1_000 };
  const dependencies: RemoteDesktopControllerDependencies = {
    authorityCurrent: vi.fn((authority) => currentAuthorities.has(authorityKey(authority))),
    capabilities: vi.fn(async () => CAPABILITIES),
    permissions: vi.fn(async () => CAPABILITIES.permissions!),
    frame: vi.fn(async () => ({ jpeg: "YWJj", width: 3, height: 1 })),
    startInput: vi.fn(async () => undefined),
    input: vi.fn(),
    stopInput: vi.fn(),
    releaseInput: vi.fn(async () => undefined),
    stopVideo: vi.fn(),
    lockScreen: vi.fn(async () => undefined),
    hostMute: vi.fn(async () => undefined),
    stopHostMute: vi.fn(async () => undefined),
    workspaceAction: vi.fn(async () => undefined),
    stopWorkspaceActions: vi.fn(async () => undefined),
    privacyScreen: vi.fn(async () => undefined),
    stopPrivacyScreen: vi.fn(async () => undefined),
    clipboardVersion: vi.fn(async () => "1"),
    stopClipboardVersion: vi.fn(),
    offer: vi.fn(async () => "answer"),
    displayModes: vi.fn(async () => [
      { id: "101", width: 1_280, height: 800, current: true, native: true },
      { id: "102", width: 1_024, height: 640, current: false, native: false }
    ]),
    setDisplayMode: vi.fn(async (_displayId, _modeId, beforeChange) => { await beforeChange(); }),
    restoreDisplayMode: vi.fn(async () => undefined),
    displayPresent: vi.fn(async () => true),
    ice: vi.fn(async (request) => ({
      attemptId: request.attemptId,
      candidates: [],
      next: request.after,
      complete: true
    })),
    changed: vi.fn(),
    now: () => clock.now,
    createLeaseId: () => `lease-${++leaseSequence}`
  };
  const controller = new RemoteDesktopController(dependencies);
  return {
    controller,
    dependencies,
    currentAuthorities,
    get now() { return clock.now; },
    set now(value: number) { clock.now = value; }
  };
}

async function start(fixture: ReturnType<typeof controllerFixture>) {
  return fixture.controller.request(AUTHORITY, {
    op: "start", displayId: "display-1"
  }) as Promise<RemoteDesktopLease>;
}

function authorityKey(authority: RemoteDesktopAuthority): string {
  const lifecycle = authority.lifecycleToken === LIFECYCLE_TOKEN ? "current" : "retired";
  return `${authority.controllerDeviceId}|${lifecycle}`;
}

function cursorPng(width = 32, height = 32): string {
  const png = Buffer.alloc(33);
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  png.writeUInt32BE(13, 8);
  png.write("IHDR", 12, "ascii");
  png.writeUInt32BE(width, 16);
  png.writeUInt32BE(height, 20);
  return png.toString("base64");
}
