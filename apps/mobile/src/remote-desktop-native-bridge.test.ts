import { describe, expect, it, vi } from "vitest";
import {
  dispatchMobileRemoteDesktopNativeCommand, MobileRemoteDesktopNativeBridgeError,
  parseMobileRemoteDesktopNativeCommand, parseMobileRemoteDesktopNativeEvent,
  parseMobileRemoteDesktopNativeInputBatch, parseMobileRemoteDesktopNativeViewport,
  sendMobileRemoteDesktopNativeInput, sendMobileRemoteDesktopNativeRequest, type MobileRemoteDesktopNativeHandle
} from "./remote-desktop-native-bridge";
import { RTC_NETWORK } from "./remote-desktop-viewer";

const epoch = "7-3-current-lease";
const attemptId = "55e39018-f634-4d47-8ffb-3182390d9b14";
const grant = { attemptId, controlGeneration: "18446744073709551615", sequenceBase: 2_000_000_000, sequenceLimit: 2_999_999_998 };
const batch = { epoch, ...grant, sequence: grant.sequenceBase + 1, events: [{ kind: "key", code: "KeyA", down: true }] };
const candidate = { candidate: "candidate:1 1 udp 123 192.0.2.1 5000 typ host", sdpMid: "0", sdpMLineIndex: 0, usernameFragment: null };
const iceServers = [{ urls: ["stun:stun.cloudflare.com:3478"] }];
const init = { type: "init", epoch, width: 1920, height: 1080, webrtc: true, audio: false,
  trickleIce: true, cursorOverlay: true, sequenceBase: grant.sequenceBase, sequenceLimit: grant.sequenceLimit, net: RTC_NETWORK, iceServers };
const event = (payload: object) => JSON.stringify({ epoch, attemptId, ...payload });
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";
const cursor = { visible: true, x: 0.4, y: 0.6, width: 16, height: 16, hotX: 1, hotY: 2, png };

describe("native Remote Desktop private commands", () => {
  it("uses an exact small native request and treats a thrown or malformed dispatch receipt as unknown", async () => {
    const request = { epoch, attemptId, message: { type: "request" as const, id: "control-1", request: { op: "control", lease: "lease", enabled: true } } };
    const handle: MobileRemoteDesktopNativeHandle = { receive: vi.fn(), sendInput: vi.fn(), sendRequest: vi.fn(async () => true) };
    expect(await sendMobileRemoteDesktopNativeRequest(handle, request)).toBe(true);
    expect(handle.sendRequest).toHaveBeenCalledWith(request);
    await expect(sendMobileRemoteDesktopNativeRequest(handle, { ...request, message: { ...request.message, request: { op: "stop", lease: "lease" } } })).rejects.toThrow();
    vi.mocked(handle.sendRequest!).mockRejectedValueOnce(new Error("native bridge failed"));
    await expect(sendMobileRemoteDesktopNativeRequest(handle, request)).rejects.toThrow();
    expect(parseMobileRemoteDesktopNativeEvent(event({ type: "channelReply", reply: { type: "reply", id: "control-1", ok: true, result: { controlling: true, controlGeneration: 2 } } }))).toMatchObject({ type: "channelReply" });
  });
  it("keeps the full input grant and uint64 text without numeric coercion", () => {
    expect(parseMobileRemoteDesktopNativeCommand({ type: "inputAuthority", epoch, grant })).toEqual({ type: "inputAuthority", epoch, grant });
    for (const controlGeneration of [0, 1, "0", "01", "+1", "1.0", "18446744073709551616"]) {
      expect(parseMobileRemoteDesktopNativeCommand({ type: "inputAuthority", epoch, grant: { ...grant, controlGeneration } })).toBeUndefined();
    }
    expect(parseMobileRemoteDesktopNativeCommand({ type: "inputAuthority", epoch, grant: null })).toEqual({ type: "inputAuthority", epoch, grant: null });
    expect(parseMobileRemoteDesktopNativeCommand({ type: "inputAuthority", epoch, attemptId, grant: null })).toBeUndefined();
  });

  it("admits the exact runtime init and rejects secret-bearing STUN or mutable network settings", () => {
    expect(parseMobileRemoteDesktopNativeCommand(init)).toEqual(init);
    expect(parseMobileRemoteDesktopNativeCommand({ ...init, net: { ...RTC_NETWORK, retryMs: [8_000, 8_000] } })).toBeUndefined();
    expect(parseMobileRemoteDesktopNativeCommand({ ...init, iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }] })).toBeUndefined();
    expect(parseMobileRemoteDesktopNativeCommand({ ...init, iceServers: [{ ...iceServers[0], username: "owner", credential: "secret" }] })).toBeUndefined();
    expect(parseMobileRemoteDesktopNativeCommand({ ...init, iceServers: [{ urls: ["turn:relay.example:3478"], username: "owner", credential: "secret" }] })).toBeDefined();
    expect(parseMobileRemoteDesktopNativeCommand({ ...init, nativeVideo: true })).toBeUndefined();
  });

  it("separates current ICE success and error receipts and preserves nullable candidate fields", () => {
    const receipt = { type: "ice", epoch, attemptId, exchangeId: 2, error: false, candidates: [candidate], next: 1, complete: false };
    expect(parseMobileRemoteDesktopNativeCommand(receipt)).toEqual(receipt);
    expect(RTC_NETWORK.maxLocalCandidates).toBe(128);
    expect(parseMobileRemoteDesktopNativeCommand({ ...receipt, next: 256 })).toBeDefined();
    expect(parseMobileRemoteDesktopNativeCommand({ ...receipt, next: 257 })).toBeUndefined();
    expect(parseMobileRemoteDesktopNativeEvent(event({ type: 'ice', candidates: [], after: 256, exchangeId: 2 }))).toBeDefined();
    expect(parseMobileRemoteDesktopNativeEvent(event({ type: 'ice', candidates: [], after: 257, exchangeId: 2 }))).toBeUndefined();
    expect(parseMobileRemoteDesktopNativeCommand({ ...receipt, error: true })).toBeUndefined();
    expect(parseMobileRemoteDesktopNativeCommand({ type: "ice", epoch, attemptId, exchangeId: 2, error: true })).toBeDefined();
    expect(parseMobileRemoteDesktopNativeCommand({ ...receipt, candidates: [{ ...candidate, sdpMLineIndex: null }] })).toBeDefined();
    for (const invalid of [
      { ...candidate, sdpMid: null, sdpMLineIndex: null }, { ...candidate, sdpMLineIndex: 32 },
      { ...candidate, candidate: "candidate:" + "x".repeat(2_048) }, { ...candidate, usernameFragment: undefined },
      { ...candidate, sdp: candidate.candidate }
    ]) expect(parseMobileRemoteDesktopNativeCommand({ ...receipt, candidates: [invalid] })).toBeUndefined();
  });

  it("validates layout points without forcing pan coordinates to integers or positive values", () => {
    const viewport = { type: "nativeViewport", epoch, x: -40.25, y: 3.5, width: 804.75, height: 452.671875, fillHeight: false };
    expect(parseMobileRemoteDesktopNativeViewport(viewport)).toEqual(viewport);
    expect(parseMobileRemoteDesktopNativeViewport({ ...viewport, width: 0 })).toBeUndefined();
    expect(parseMobileRemoteDesktopNativeViewport({ ...viewport, x: Infinity })).toBeUndefined();
    expect(parseMobileRemoteDesktopNativeViewport({ ...viewport, attemptId })).toBeUndefined();
  });

  it("requires complete PiP policy and a safe current restore identifier", () => {
    expect(parseMobileRemoteDesktopNativeCommand({ type: "pipPolicy", epoch, attemptId, enabled: true, preparing: true, authorized: false })).toBeDefined();
    expect(parseMobileRemoteDesktopNativeCommand({ type: "pipPolicy", epoch, attemptId, enabled: true, authorized: true })).toBeUndefined();
    expect(parseMobileRemoteDesktopNativeCommand({ type: "restorePresentation", epoch, attemptId, restoreId: 3 })).toBeDefined();
    for (const restoreId of [true, 0, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(parseMobileRemoteDesktopNativeCommand({ type: "restorePresentation", epoch, attemptId, restoreId })).toBeUndefined();
    }
  });
});

describe("native input boundary", () => {
  it("accepts the six existing event kinds and exact sequence window", () => {
    const events = [
      { kind: "move", x: 0, y: 1 }, { kind: "button", button: 2, down: false, x: 0.5, y: 0.5 },
      { kind: "scroll", dx: -2_000, dy: 2_000 }, { kind: "key", code: "MetaLeft", down: false },
      { kind: "text", text: "日本語" }, { kind: "release" }
    ];
    const parsed = parseMobileRemoteDesktopNativeInputBatch({ ...batch, sequence: grant.sequenceLimit, events });
    expect(parsed).toEqual({ ...batch, sequence: grant.sequenceLimit, events });
    expect(Object.isFrozen(parsed?.events)).toBe(true);
    for (const sequence of [true, grant.sequenceBase, grant.sequenceLimit + 1, 2_000_000_001.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(parseMobileRemoteDesktopNativeInputBatch({ ...batch, sequence })).toBeUndefined();
    }
    expect(parseMobileRemoteDesktopNativeInputBatch({ ...batch, sequenceBase: undefined })).toBeUndefined();
  });

  it("rejects malformed effects and oversized batches before native dispatch", () => {
    for (const events of [
      [], Array.from({ length: 65 }, () => ({ kind: "release" })), [{ kind: "move", x: -0.1, y: 0 }],
      [{ kind: "key", code: "UnknownKey", down: true }], [{ kind: "key", code: "KeyA", down: 1 }],
      [{ kind: "release", sequence: 1 }], [{ kind: "text", text: "x".repeat(4_097) }],
      Array.from({ length: 5 }, () => ({ kind: "text", text: "x".repeat(4_096) }))
    ]) expect(parseMobileRemoteDesktopNativeInputBatch({ ...batch, events })).toBeUndefined();
    expect(parseMobileRemoteDesktopNativeInputBatch({ ...batch, events: Array.from({ length: 3 }, () => ({ kind: "text", text: "語".repeat(4_000) })) })).toBeUndefined();
  });

  it("preserves known sendData false, accepted true and unknown failure without replay", async () => {
    const handle: MobileRemoteDesktopNativeHandle = { receive: async () => undefined, sendInput: vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true).mockRejectedValueOnce(new Error("secret SDK diagnostic")) };
    await expect(sendMobileRemoteDesktopNativeInput(handle, batch)).resolves.toBe(false);
    await expect(sendMobileRemoteDesktopNativeInput(handle, batch)).resolves.toBe(true);
    await expect(sendMobileRemoteDesktopNativeInput(handle, batch)).rejects.toMatchObject({ code: "input-failed", epoch, attemptId });
    expect(handle.sendInput).toHaveBeenCalledTimes(3);
  });
});

describe("native event origin and finite receipts", () => {
  it("accepts native frame and lifecycle receipts only through JSON with a canonical attempt", () => {
    expect(parseMobileRemoteDesktopNativeEvent(event({ type: "videoFrameReady" }))).toEqual({ type: "videoFrameReady", epoch, attemptId });
    expect(parseMobileRemoteDesktopNativeEvent({ type: "videoFrameReady", epoch, attemptId })).toBeUndefined();
    expect(parseMobileRemoteDesktopNativeEvent(event({ type: "videoFrameReady", attemptId: "1" }))).toBeUndefined();
    expect(parseMobileRemoteDesktopNativeEvent(event({ type: "videoFrameReady", attemptId: attemptId.toUpperCase() }))).toBeUndefined();
    expect(parseMobileRemoteDesktopNativeEvent(event({ type: "presentationStarting" }))).toBeDefined();
    expect(parseMobileRemoteDesktopNativeEvent(event({ type: "presentationRestore", restoreId: 4, inlineVisible: false, sourceHidden: true }))).toBeDefined();
    expect(parseMobileRemoteDesktopNativeEvent(event({ type: "presentationRestore", restoreId: 4 }))).toBeUndefined();
    expect(parseMobileRemoteDesktopNativeEvent(event({ type: "ready" }))).toBeUndefined();
  });

  it("keeps nullable network metrics and rejects arbitrary diagnostics or states", () => {
    const payload = { type: "network", transport: "relay", bytesPerSecond: null, latencyMs: 18.5 };
    expect(parseMobileRemoteDesktopNativeEvent(event(payload))).toEqual({ epoch, attemptId, ...payload });
    for (const change of [
      { bytesPerSecond: undefined }, { bytesPerSecond: -1 }, { latencyMs: "18" }, { transport: "address.example" }, { description: "private remote text" }
    ]) expect(parseMobileRemoteDesktopNativeEvent(event({ ...payload, ...change }))).toBeUndefined();
    expect(parseMobileRemoteDesktopNativeEvent(event({ type: "presentationFailed", reason: "avkit" }))).toBeDefined();
    expect(parseMobileRemoteDesktopNativeEvent(event({ type: "presentationFailed", reason: "avkit", description: "SDK message" }))).toBeUndefined();
    expect(parseMobileRemoteDesktopNativeEvent(event({ type: "fallback", reason: "capture-pending", retry: true }))).toBeDefined();
    expect(parseMobileRemoteDesktopNativeEvent(event({ type: "fallback", reason: "https://private.example", retry: true }))).toBeUndefined();
  });

  it("bounds cursor geometry and PNG payload while retaining the existing cursor representation", () => {
    expect(parseMobileRemoteDesktopNativeEvent(event({ type: "nativeCursor", cursor }))).toEqual({ type: "nativeCursor", epoch, attemptId, cursor });
    expect(parseMobileRemoteDesktopNativeEvent(event({ type: "nativeCursor", cursor: null }))).toBeDefined();
    for (const change of [{ x: 2 }, { width: 257 }, { hotX: 17 }, { png: "data:image/png;base64," + png }, { bgra: "buffer" }]) {
      expect(parseMobileRemoteDesktopNativeEvent(event({ type: "nativeCursor", cursor: { ...cursor, ...change } }))).toBeUndefined();
    }
  });
});

it("dispatches only validated commands to the captured handle with the original scope", async () => {
  const original: MobileRemoteDesktopNativeHandle = { receive: vi.fn().mockResolvedValue(undefined), sendInput: async () => false };
  const replacement: MobileRemoteDesktopNativeHandle = { receive: vi.fn(), sendInput: async () => false };
  await expect(dispatchMobileRemoteDesktopNativeCommand(original, { ...init, nativeVideo: true })).resolves.toBe(true);
  expect(original.receive).toHaveBeenCalledWith(init);
  expect(replacement.receive).not.toHaveBeenCalled();
  await expect(dispatchMobileRemoteDesktopNativeCommand(original, { type: "nativeVideo", epoch, attemptId })).resolves.toBe(false);
  await expect(dispatchMobileRemoteDesktopNativeCommand(original, { type: "stop" })).rejects.toBeInstanceOf(MobileRemoteDesktopNativeBridgeError);
  expect(original.receive).toHaveBeenCalledTimes(1);
  const failure = { receive: async () => { throw new Error("SDP credential text"); }, sendInput: async () => false };
  await expect(dispatchMobileRemoteDesktopNativeCommand(failure, { type: "stop", epoch: "retired-owner" })).rejects.toMatchObject({
    code: "command-failed", epoch: "retired-owner", message: "Remote Desktop native bridge unavailable."
  });
});
