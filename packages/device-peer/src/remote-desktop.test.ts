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
  cursorOverlay: true
});

describe("remote desktop portable protocol", () => {
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
    expect(parseRemoteDesktopVideoSettings({ fps: 60, bitrate: 8_000_000, audio: true }))
      .toEqual({ fps: 60, bitrate: 8_000_000, audio: true });
    expect(() => parseRemoteDesktopVideoSettings({ fps: 24, bitrate: 8_000_000, audio: true }))
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
      op: "resolution", lease: "lease-1", controlGeneration: 2, modeId: "101"
    })).toEqual({
      op: "resolution", lease: "lease-1", controlGeneration: 2, modeId: "101"
    });
    expect(() => parseRemoteDesktopRequest({
      op: "resolution", lease: "lease-1", controlGeneration: 0, modeId: "101"
    })).toThrowError("INVALID_REMOTE_DESKTOP_REQUEST");
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

  it("sanitizes host capabilities to the admitted macOS media surface", () => {
    expect(parseRemoteDesktopHostCapabilities({
      ...CAPABILITIES,
      ignoredFutureFlag: true
    })).toEqual(CAPABILITIES);
    expect(() => parseRemoteDesktopHostCapabilities({
      ...CAPABILITIES,
      permissions: undefined
    })).toThrowError("INVALID_REMOTE_DESKTOP_CAPABILITIES");
    expect(() => parseRemoteDesktopHostCapabilities({
      ...CAPABILITIES,
      platform: "linux",
      displayModes: true,
      cursorOverlay: false
    })).toThrowError("INVALID_REMOTE_DESKTOP_CAPABILITIES");
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
    expect(fixture.dependencies.frame).toHaveBeenCalledWith("display-1", true, AUTHORITY);

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
        beforeChange();
        await new Promise<void>((resolve) => { finish = resolve; });
      }
    );
    const pending = fixture.controller.request(AUTHORITY, {
      op: "resolution",
      lease: lease.lease,
      controlGeneration: controlled.controlGeneration,
      modeId: "102"
    });
    await vi.waitFor(() => expect(fixture.controller.state).toBeUndefined());
    await expect(fixture.controller.request(AUTHORITY, {
      op: "start", displayId: "display-1"
    })).rejects.toThrowError("REMOTE_DESKTOP_DISPLAY_BUSY");
    finish();
    await expect(pending).resolves.toEqual({ ok: true });
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
      modeId: "999"
    })).rejects.toThrowError("REMOTE_DESKTOP_DISPLAY_MODE_MISSING");
    expect(fixture.controller.state).toMatchObject({ lease: lease.lease, controlling: true });

    vi.mocked(fixture.dependencies.setDisplayMode!).mockImplementationOnce(
      async (_displayId, _modeId, beforeChange) => {
        beforeChange();
        throw new Error("REMOTE_DESKTOP_DISPLAY_MODES_UNAVAILABLE");
      }
    );
    await expect(fixture.controller.request(AUTHORITY, {
      op: "resolution",
      lease: lease.lease,
      controlGeneration: controlled.controlGeneration,
      modeId: "102"
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
    stopVideo: vi.fn(),
    offer: vi.fn(async () => "answer"),
    displayModes: vi.fn(async () => [
      { id: "101", width: 1_280, height: 800, current: true, native: true },
      { id: "102", width: 1_024, height: 640, current: false, native: false }
    ]),
    setDisplayMode: vi.fn(async (_displayId, _modeId, beforeChange) => { beforeChange(); }),
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
