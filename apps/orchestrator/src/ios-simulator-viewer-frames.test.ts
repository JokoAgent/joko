import { OperationalStore } from "@joko/store";
import { expect, it, vi } from "vitest";
import type { SimulatorDriverCoordinator } from "./ios-simulator-driver-coordinator.js";
import { SimulatorOwnershipRegistry } from "./ios-simulator-ownership.js";
import { SimulatorViewerFrameCoordinator } from "./ios-simulator-viewer-frames.js";

const SCOPE = { sessionId: "task", targetId: "local", generation: 1 } as const;
const DEVICE = { udid: "A0123456-1234-1234-1234-123456789ABC", name: "iPhone",
  state: "Booted", isAvailable: true, runtimeIdentifier: "com.apple.CoreSimulator.SimRuntime.iOS-19-0",
  runtimeName: "iOS 19", runtimeVersion: "19.0",
  deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-17", lastBootedAt: null } as const;

function fixture(streamMjpegFrames: SimulatorDriverCoordinator["streamMjpegFrames"], native?: Pick<
  SimulatorDriverCoordinator, "probeNativeH264" | "streamNativeH264Frames">) {
  const store = new OperationalStore(":memory:");
  store.upsertBackend({ id: "pi", displayName: "Pi", version: "fixture", health: "healthy",
    adapterKind: "fixture", instanceGeneration: 0, installationState: "installed",
    authenticationState: "not_required", capabilities: new Map(), models: [], tools: [], diagnostics: [] });
  store.upsertTarget({ id: "local", backendId: "pi", displayName: "Local",
    workspaceRoot: "D:/workspace", managed: false, trusted: true });
  store.createSession({ id: SCOPE.sessionId, backendId: "pi", targetId: SCOPE.targetId,
    title: "Task", binding: { opaqueRef: "task", generation: 1 },
    pinned: false, archived: false, permissionMode: "ask", planMode: false, fastMode: false,
    createdAt: 1, updatedAt: 1 });
  const ownership = new SimulatorOwnershipRegistry(store);
  const bound = ownership.bindExternalDevice(SCOPE, DEVICE);
  const instance = ownership.attachViewer(SCOPE,
    { instanceId: bound.instanceId, generation: bound.generation, leaseId: bound.lease.id });
  const route = { instanceId: instance.instanceId, generation: instance.generation,
    leaseId: instance.lease.id };
  const driver = { isReady: vi.fn(() => true), mjpegConfigurationLease: vi.fn(() => "driver-lease"),
    configureMjpegProfile: vi.fn(async () => undefined),
    streamMjpegFrames, ...native } as Pick<SimulatorDriverCoordinator,
    "isReady" | "mjpegConfigurationLease" | "configureMjpegProfile" | "streamMjpegFrames"> & typeof native;
  return { store, ownership, instance, route, driver,
    frames: new SimulatorViewerFrameCoordinator(ownership, driver) };
}

it("streams only the exact ready task route without persisting frame bytes", async () => {
  const jpeg = new Uint8Array([0xff, 0xd8, 1, 0xff, 0xd9]);
  const h = fixture(async function* () { yield { bytes: jpeg, receivedAt: new Date().toISOString() }; });
  try {
    const watch = h.frames.watch(SCOPE, h.route);
    expect((await watch.next()).value).toEqual({ kind: "connecting", attempt: 0,
      nativeRoute: "inactive" });
    expect((await watch.next()).value).toMatchObject({ kind: "frame", sequence: 1, bytes: jpeg });
    expect(h.frames.snapshot(SCOPE, h.route)).toMatchObject({ adapter: "wda-mjpeg",
      encoding: "jpeg", state: "streaming", sequence: 1 });
    expect(h.frames.inputView(SCOPE, h.route)).toMatchObject({ state: "streaming",
      encoding: "jpeg", viewerOrientation: null, lastFrameAt: expect.any(String) });
    expect(h.driver.configureMjpegProfile).toHaveBeenCalledWith(h.instance,
      { framesPerSecond: 10, jpegQuality: 45, scalingPercent: 70 }, expect.any(AbortSignal));
    expect(h.store.listOperations({ sessionId: SCOPE.sessionId })).toEqual([]);
    await watch.return(undefined);
    expect(h.frames.snapshot(SCOPE, h.route)).toBeNull();
    await expect(async () => {
      for await (const _event of h.frames.watch({ ...SCOPE, sessionId: "other" }, h.route)) { /* denied */ }
    }).rejects.toMatchObject({ code: "STALE_SCOPE" });
  } finally { h.store.close(); }
});

it("prefers owned H.264 frames and falls back to MJPEG after native loss", async () => {
  const h264 = new Uint8Array([0, 0, 0, 1, 0x65, 0x88]);
  const jpeg = new Uint8Array([0xff, 0xd8, 1, 0xff, 0xd9]);
  const native = { probeNativeH264: vi.fn(async () => true),
    streamNativeH264Frames: vi.fn(async function* () {
      yield { sequence: 1, width: 16, height: 12, timestampMicros: 1_000,
        keyFrame: true, format: "annex-b" as const, bytes: h264,
        receivedAt: new Date().toISOString() };
      throw new Error("native capture lost");
    }) };
  const h = fixture(async function* (_instance, signal) {
    yield { bytes: jpeg, receivedAt: new Date().toISOString() };
    await new Promise<void>(resolve => signal?.addEventListener("abort", () => resolve(), { once: true }));
  }, native);
  try {
    const watch = h.frames.watch(SCOPE, h.route, undefined,
      { preferNativeH264: true, profile: { framesPerSecond: 20,
        scalingPercent: 70, orientation: "PORTRAIT" } });
    expect((await watch.next()).value).toEqual({ kind: "connecting", attempt: 0,
      nativeRoute: "active" });
    expect((await watch.next()).value).toMatchObject({ kind: "h264", sequence: 1,
      bytes: h264, keyFrame: true });
    expect(h.frames.snapshot(SCOPE, h.route)).toMatchObject({ adapter: "native-h264",
      encoding: "h264", state: "streaming", sequence: 1 });
    expect(h.frames.inputView(SCOPE, h.route)).toMatchObject({ state: "streaming",
      encoding: "h264", viewerOrientation: "PORTRAIT", lastFrameAt: expect.any(String) });
    expect((await watch.next()).value).toEqual({ kind: "reconnecting", attempt: 1,
      nativeRoute: "fallback_lost" });
    expect((await watch.next()).value).toMatchObject({ kind: "frame", sequence: 2,
      bytes: jpeg, nativeRoute: "fallback_lost" });
    expect(h.frames.snapshot(SCOPE, h.route)).toMatchObject({ adapter: "wda-mjpeg",
      encoding: "jpeg", sequence: 2 });
    expect(h.frames.inputView(SCOPE, h.route)).toMatchObject({ state: "streaming",
      encoding: "jpeg", viewerOrientation: null, lastFrameAt: expect.any(String) });
    expect(native.probeNativeH264).toHaveBeenCalledOnce();
    expect(native.streamNativeH264Frames).toHaveBeenCalledOnce();
    expect(h.driver.configureMjpegProfile).toHaveBeenCalledOnce();
    await watch.return(undefined);
  } finally { h.store.close(); }
});

it("reports native fallback per subscription and re-probes only on a new explicit watch", async () => {
  let nativeReady = false;
  const native = { probeNativeH264: vi.fn(async () => nativeReady),
    streamNativeH264Frames: vi.fn(async function* (_instance, _profile, signal?: AbortSignal) {
      yield { sequence: 1, width: 16, height: 12, timestampMicros: 1_000,
        keyFrame: true, format: "annex-b" as const,
        bytes: new Uint8Array([0, 0, 0, 1, 0x65, 0x88]),
        receivedAt: new Date().toISOString() };
      await new Promise<void>(resolve => signal?.addEventListener("abort", () => resolve(), { once: true }));
    }) };
  const h = fixture(async function* (_instance, signal) {
    yield { bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
      receivedAt: new Date().toISOString() };
    await new Promise<void>(resolve => signal?.addEventListener("abort", () => resolve(), { once: true }));
  }, native);
  const profile = { preferNativeH264: true, profile: { framesPerSecond: 20,
    scalingPercent: 70, orientation: "PORTRAIT" as const } };
  try {
    const first = h.frames.watch(SCOPE, h.route, undefined, profile);
    expect((await first.next()).value).toMatchObject({ kind: "connecting",
      nativeRoute: "fallback_unavailable" });
    expect((await first.next()).value).toMatchObject({ kind: "frame",
      nativeRoute: "fallback_unavailable" });
    nativeReady = true;
    expect(native.probeNativeH264).toHaveBeenCalledTimes(1);
    await first.return(undefined);
    const second = h.frames.watch(SCOPE, h.route, undefined, profile);
    expect((await second.next()).value).toMatchObject({ kind: "connecting", nativeRoute: "active" });
    expect((await second.next()).value).toMatchObject({ kind: "h264", nativeRoute: "active" });
    expect(native.probeNativeH264).toHaveBeenCalledTimes(2);
    await second.return(undefined);
    const decoderFallback = h.frames.watch(SCOPE, h.route, undefined, {
      ...profile, preferNativeH264: false, clientFallbackReason: "decode_failed" });
    expect((await decoderFallback.next()).value).toMatchObject({ kind: "connecting",
      nativeRoute: "fallback_decode" });
    expect((await decoderFallback.next()).value).toMatchObject({ kind: "frame",
      nativeRoute: "fallback_decode" });
    expect(native.probeNativeH264).toHaveBeenCalledTimes(2);
    await decoderFallback.return(undefined);
  } finally { h.store.close(); }
});

it("does not let a second MJPEG subscription silently replace the active profile", async () => {
  const h = fixture(async function* (_instance, signal) {
    yield { bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
      receivedAt: new Date().toISOString() };
    await new Promise<void>(resolve => signal?.addEventListener("abort", () => resolve(), { once: true }));
  });
  try {
    const first = h.frames.watch(SCOPE, h.route);
    await first.next();
    await first.next();
    const second = h.frames.watch(SCOPE, h.route, undefined, { preferNativeH264: false,
      profile: { framesPerSecond: 20, scalingPercent: 70, orientation: "PORTRAIT" },
      mjpegProfile: { framesPerSecond: 20, jpegQuality: 70, scalingPercent: 100 } });
    expect((await second.next()).value).toEqual({ kind: "connecting", attempt: 0,
      nativeRoute: "inactive" });
    await expect(second.next()).rejects.toMatchObject({ code: "PROFILE_CONFLICT" });
    expect(h.driver.configureMjpegProfile).toHaveBeenCalledOnce();
    await first.return(undefined);
  } finally { h.store.close(); }
});

it("fails closed after an uncertain WDA profile response instead of publishing a frame", async () => {
  const h = fixture(async function* () {
    yield { bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
      receivedAt: new Date().toISOString() };
  });
  try {
    vi.spyOn(h.driver, "configureMjpegProfile").mockRejectedValue(new Error("settings response lost"));
    const first = h.frames.watch(SCOPE, h.route);
    expect((await first.next()).value).toEqual({ kind: "connecting", attempt: 0,
      nativeRoute: "inactive" });
    expect((await first.next()).value).toEqual({ kind: "reconnecting", attempt: 1,
      nativeRoute: "inactive" });
    await expect(first.next()).rejects.toMatchObject({ code: "PROFILE_UNCERTAIN" });
    const second = h.frames.watch(SCOPE, h.route);
    await second.next();
    await expect(second.next()).rejects.toMatchObject({ code: "PROFILE_UNCERTAIN" });
    h.frames.clear(h.instance.instanceId);
    const third = h.frames.watch(SCOPE, h.route);
    await third.next();
    await expect(third.next()).rejects.toMatchObject({ code: "PROFILE_UNCERTAIN" });
    expect(h.driver.configureMjpegProfile).toHaveBeenCalledOnce();
    vi.mocked(h.driver.mjpegConfigurationLease).mockReturnValue("replacement-lease");
    vi.mocked(h.driver.configureMjpegProfile).mockResolvedValue(undefined);
    const fourth = h.frames.watch(SCOPE, h.route);
    await fourth.next();
    expect((await fourth.next()).value).toMatchObject({ kind: "frame" });
    expect(h.driver.configureMjpegProfile).toHaveBeenCalledTimes(2);
    await fourth.return(undefined);
  } finally { h.store.close(); }
});

it("rejects a rotated instance and stops a visible subscription on explicit clear", async () => {
  let released = false;
  const h = fixture(async function* (_instance, signal) {
    try {
      yield { bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
        receivedAt: new Date().toISOString() };
      await new Promise<void>(resolve => signal?.addEventListener("abort", () => resolve(), { once: true }));
    } finally { released = true; }
  });
  try {
    const watch = h.frames.watch(SCOPE, h.route);
    await watch.next();
    await watch.next();
    h.ownership.failLifecycle(SCOPE, h.route, "ROUTE_CHANGED");
    await expect(watch.next()).rejects.toMatchObject({ code: "STALE_SCOPE" });
    const latest = h.ownership.listForTask(SCOPE)[0]!;
    const currentRoute = { instanceId: latest.instanceId,
      generation: latest.generation, leaseId: latest.lease.id };
    await expect(async () => {
      for await (const _event of h.frames.watch(SCOPE, currentRoute)) { /* no longer ready */ }
    }).rejects.toThrow();
    h.frames.clear(h.instance.instanceId);
    expect(released).toBe(true);
  } finally { h.store.close(); }
});

it("bounds reconnect attempts and reports a visible disconnected state", async () => {
  const stream = vi.fn(async function* () { throw new Error("MJPEG ended"); });
  const h = fixture(stream);
  try {
    const states: string[] = [];
    for await (const event of h.frames.watch(SCOPE, h.route)) states.push(event.kind);
    expect(states).toEqual(["connecting", "reconnecting", "reconnecting",
      "reconnecting", "disconnected"]);
    expect(stream).toHaveBeenCalledTimes(4);
  } finally { h.store.close(); }
});
