import { OperationalStore } from "@joko/store";
import { WdaClientError } from "@joko/tool-ios-simulator";
import { expect, it } from "vitest";
import { SimulatorOwnershipRegistry, type PublicSimulatorInstance } from "./ios-simulator-ownership.js";
import { SimulatorScreenObservationCoordinator } from "./ios-simulator-screen-observation.js";

const SCOPE = { sessionId: "screen-task", targetId: "local", generation: 1 } as const;
const UDID = "A0123456-1234-1234-1234-123456789ABC";
const DEVICE = { udid: UDID, name: "iPhone", state: "Booted", isAvailable: true,
  runtimeIdentifier: "com.apple.CoreSimulator.SimRuntime.iOS-19-0", runtimeName: "iOS 19.0",
  runtimeVersion: "19.0", deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-17",
  lastBootedAt: null } as const;

function route(instance: PublicSimulatorInstance) {
  return { instanceId: instance.instanceId, generation: instance.generation, leaseId: instance.lease.id };
}

function fixture() {
  const store = new OperationalStore(":memory:");
  store.upsertBackend({ id: "pi", displayName: "Pi", version: "fixture", health: "healthy",
    adapterKind: "fixture", instanceGeneration: 0, installationState: "installed",
    authenticationState: "not_required", capabilities: new Map(), models: [], tools: [], diagnostics: [] });
  store.upsertTarget({ id: "local", backendId: "pi", displayName: "Local workspace",
    workspaceRoot: "D:/workspace", managed: false, trusted: true });
  store.createSession({ id: SCOPE.sessionId, backendId: "pi", targetId: SCOPE.targetId,
    title: "Screen task", binding: { opaqueRef: "screen-task", generation: 1 }, pinned: false,
    archived: false, permissionMode: "ask", planMode: false, fastMode: false,
    createdAt: 1, updatedAt: 1 });
  const ownership = new SimulatorOwnershipRegistry(store);
  const bound = ownership.bindExternalDevice(SCOPE, DEVICE);
  const instance = ownership.attachViewer(SCOPE, route(bound));
  let tree: unknown = { type: "XCUIElementTypeButton", label: "Continue",
    rect: { x: 0, y: 0, width: 100, height: 44 } };
  let observe: (signal?: AbortSignal) => Promise<{ capturedAt: string; tree: unknown }> = async () =>
    ({ capturedAt: new Date().toISOString(), tree });
  let ready = true;
  const screen = new SimulatorScreenObservationCoordinator(ownership, {
    isReady: () => ready,
    observeAccessibilityTree: (_instance, signal) => observe(signal),
    observeViewport: async () => ({ width: 393, height: 852, orientation: "PORTRAIT" as const })
  });
  return { store, ownership, instance, screen, setTree: (value: unknown) => { tree = value; },
    setObserve: (value: typeof observe) => { observe = value; }, setReady: (value: boolean) => { ready = value; } };
}

it("fences screen observations by the current task route and driver readiness", async () => {
  const h = fixture();
  try {
    const first = await h.screen.screenMap(SCOPE, route(h.instance));
    expect(first).toMatchObject({ viewport: { width: 393, height: 852, orientation: "PORTRAIT" },
      screenMap: { instanceId: h.instance.instanceId, generation: h.instance.generation,
        elements: [{ role: "XCUIElementTypeButton", label: "Continue" }] } });
    const audited = await h.screen.audit(SCOPE, route(h.instance));
    expect(audited).toMatchObject({ audit: { violationCount: 0 } });
    expect(audited.audit.snapshotId).not.toBe(first.screenMap.snapshotId);
    h.setTree({ type: "XCUIElementTypeButton", label: "Next",
      rect: { x: 0, y: 0, width: 100, height: 44 } });
    const compared = await h.screen.compare(SCOPE, route(h.instance), first.screenMap);
    expect(compared.diff).toMatchObject({ added: [expect.any(Object)], removed: [expect.any(Object)] });
    await expect(h.screen.wait(SCOPE, route(h.instance),
      { kind: "element_exists", selector: { labelContains: "Next" } }))
      .resolves.toMatchObject({ timedOut: false, stable: false });
    h.setObserve(async () => { throw new WdaClientError("UNREACHABLE", "Driver loopback service is unavailable."); });
    await expect(h.screen.audit(SCOPE, route(h.instance)))
      .rejects.toMatchObject({ code: "UNREACHABLE" });
    h.setReady(false);
    await expect(h.screen.screenMap(SCOPE, route(h.instance)))
      .rejects.toMatchObject({ code: "DRIVER_RUNTIME_LOST" });
    h.setReady(true);
    h.store.updateSession(SCOPE.sessionId, { archived: true });
    await expect(h.screen.screenMap(SCOPE, route(h.instance)))
      .rejects.toMatchObject({ code: "STALE_SCOPE" });
  } finally { h.store.close(); }
});

it("invalidates an owned app screen without requiring a live driver", async () => {
  const h = fixture();
  try {
    const current = await h.screen.screenMap(SCOPE, route(h.instance));
    h.setReady(false);
    expect(h.screen.invalidateOwnedRoute(SCOPE, route(h.instance))).toBeGreaterThan(0);
    h.setReady(true);
    expect(() => h.screen.requireInteractionSnapshot(SCOPE, route(h.instance),
      current.screenMap.snapshotId)).toThrowError("The UI changed. Read a new screen map.");
    h.store.updateSession(SCOPE.sessionId, { archived: true });
    expect(() => h.screen.invalidateOwnedRoute(SCOPE, route(h.instance)))
      .toThrowError(/task|scope|archived/iu);
  } finally { h.store.close(); }
});

it("rejects an older asynchronous screen capture after a newer one completes", async () => {
  const h = fixture();
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  let first = true;
  h.setObserve(async () => {
    if (first) { first = false; entered(); await gate; }
    return { capturedAt: new Date().toISOString(), tree: {
      type: "XCUIElementTypeButton", label: "Continue" } };
  });
  try {
    const old = h.screen.screenMap(SCOPE, route(h.instance));
    await started;
    const current = await h.screen.screenMap(SCOPE, route(h.instance));
    release();
    await expect(old).rejects.toMatchObject({ code: "STALE_UI_SNAPSHOT" });
    expect(current.screenMap.snapshotId).toBeTruthy();
  } finally { release(); h.store.close(); }
});

it("returns a bounded timeout when a requested UI condition does not appear", async () => {
  const h = fixture();
  try {
    await expect(h.screen.wait(SCOPE, route(h.instance),
      { kind: "element_exists", selector: { labelContains: "Absent" } },
      { timeoutMs: 100, pollIntervalMs: 100, stableForMs: 100 }))
      .rejects.toMatchObject({ code: "UI_WAIT_TIMEOUT" });
    await expect(h.screen.observeAfter(SCOPE, route(h.instance), "stable",
      { timeoutMs: 100, stableForMs: 100 })).resolves.toMatchObject({
      mode: "stable", timedOut: true, stable: false, screenMap: { elements: expect.any(Array) }
    });
  } finally { h.store.close(); }
});

it("bounds an in-flight capture by the wait deadline and distinguishes caller cancellation", async () => {
  const h = fixture();
  let entered!: () => void;
  let started = new Promise<void>(resolve => { entered = resolve; });
  h.setObserve(signal => new Promise((_resolve, reject) => {
    entered();
    signal?.addEventListener("abort", () => reject(new Error("request aborted")), { once: true });
  }));
  try {
    const timed = h.screen.wait(SCOPE, route(h.instance),
      { kind: "screen_stable" }, { timeoutMs: 100, pollIntervalMs: 100, stableForMs: 100 });
    await started;
    await expect(timed)
      .rejects.toMatchObject({ code: "UI_WAIT_TIMEOUT" });
    started = new Promise<void>(resolve => { entered = resolve; });
    const controller = new AbortController();
    const pending = h.screen.wait(SCOPE, route(h.instance),
      { kind: "screen_stable" }, { timeoutMs: 5_000 }, controller.signal);
    await started;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "OBSERVATION_CANCELLED" });
  } finally { h.store.close(); }
});
