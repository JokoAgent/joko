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
  const driver = { isReady: vi.fn(() => true), streamMjpegFrames, ...native } as Pick<
    SimulatorDriverCoordinator, "isReady" | "streamMjpegFrames"> & typeof native;
  return { store, ownership, instance, route, frames: new SimulatorViewerFrameCoordinator(ownership, driver) };
}

it("streams only the exact ready task route without persisting frame bytes", async () => {
  const jpeg = new Uint8Array([0xff, 0xd8, 1, 0xff, 0xd9]);
  const h = fixture(async function* () { yield { bytes: jpeg, receivedAt: new Date().toISOString() }; });
  try {
    const watch = h.frames.watch(SCOPE, h.route);
    expect((await watch.next()).value).toEqual({ kind: "connecting", attempt: 0 });
    expect((await watch.next()).value).toMatchObject({ kind: "frame", sequence: 1, bytes: jpeg });
    expect(h.frames.snapshot(SCOPE, h.route)).toMatchObject({ adapter: "wda-mjpeg",
      encoding: "jpeg", state: "streaming", sequence: 1 });
    expect(h.frames.inputView(SCOPE, h.route)).toMatchObject({ state: "streaming",
      encoding: "jpeg", viewerOrientation: null, lastFrameAt: expect.any(String) });
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
    expect((await watch.next()).value).toEqual({ kind: "connecting", attempt: 0 });
    expect((await watch.next()).value).toMatchObject({ kind: "h264", sequence: 1,
      bytes: h264, keyFrame: true });
    expect(h.frames.snapshot(SCOPE, h.route)).toMatchObject({ adapter: "native-h264",
      encoding: "h264", state: "streaming", sequence: 1 });
    expect(h.frames.inputView(SCOPE, h.route)).toMatchObject({ state: "streaming",
      encoding: "h264", viewerOrientation: "PORTRAIT", lastFrameAt: expect.any(String) });
    expect((await watch.next()).value).toEqual({ kind: "reconnecting", attempt: 1 });
    expect((await watch.next()).value).toMatchObject({ kind: "frame", sequence: 2,
      bytes: jpeg });
    expect(h.frames.snapshot(SCOPE, h.route)).toMatchObject({ adapter: "wda-mjpeg",
      encoding: "jpeg", sequence: 2 });
    expect(h.frames.inputView(SCOPE, h.route)).toMatchObject({ state: "streaming",
      encoding: "jpeg", viewerOrientation: null, lastFrameAt: expect.any(String) });
    expect(native.probeNativeH264).toHaveBeenCalledOnce();
    expect(native.streamNativeH264Frames).toHaveBeenCalledOnce();
    await watch.return(undefined);
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
