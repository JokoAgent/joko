import { randomUUID } from "node:crypto";
import { OperationalStore } from "@joko/store";
import { SimulatorNativeHidError } from "@joko/tool-ios-simulator";
import { expect, it, vi } from "vitest";
import { SimulatorOwnershipRegistry, type PublicSimulatorInstance } from "./ios-simulator-ownership.js";
import { SimulatorViewerLiveTouchCoordinator } from "./ios-simulator-viewer-live-touch.js";

const SCOPE = { sessionId: "live-touch-task", targetId: "local", generation: 1 } as const;
const DEVICE = { udid: "A0123456-1234-1234-1234-123456789ABC", name: "Joko iPhone",
  state: "Booted", isAvailable: true,
  runtimeIdentifier: "com.apple.CoreSimulator.SimRuntime.iOS-19-0",
  runtimeName: "iOS 19.0", runtimeVersion: "19.0",
  deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-17", lastBootedAt: null } as const;
const VIEWPORT = { width: 100, height: 200, orientation: "PORTRAIT" as const };
const POINT = { xRatio: 0.2, yRatio: 0.3 };

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
    title: "Live touch", binding: { opaqueRef: SCOPE.sessionId, generation: 1 }, pinned: false,
    archived: false, permissionMode: "ask", planMode: false, fastMode: false,
    createdAt: 1, updatedAt: 1 });
  const ownership = new SimulatorOwnershipRegistry(store);
  const bound = ownership.bindExternalDevice(SCOPE, DEVICE);
  const started = ownership.completeLifecycle(SCOPE, route(bound),
    { action: "start", bootedByAgent: false });
  const instance = ownership.attachViewer(SCOPE, route(started));
  const contact = { move: vi.fn(async () => undefined), end: vi.fn(async () => undefined),
    cancel: vi.fn(async () => undefined), forceRelease: vi.fn() };
  const driver = { isReady: vi.fn(() => true), probeNativeLiveInput: vi.fn(async () => true),
    beginNativeLiveTouch: vi.fn(async () => contact) };
  const screen = { requireInteractionSnapshot: vi.fn(() => ({})),
    invalidateInteraction: vi.fn(() => 1) };
  const touch = new SimulatorViewerLiveTouchCoordinator(store, ownership,
    driver as never, screen as never);
  return { store, ownership, instance, driver, screen, contact, touch };
}

it("holds one durable input effect across begin, mapped move and terminal up", async () => {
  const h = fixture();
  const gestureId = randomUUID();
  const instanceRoute = route(h.instance);
  try {
    await h.touch.begin(SCOPE, instanceRoute, gestureId, POINT, randomUUID(), VIEWPORT,
      "LANDSCAPE");
    expect(h.driver.beginNativeLiveTouch).toHaveBeenCalledWith(h.instance, gestureId,
      { x: 0.3, y: 0.8 }, undefined);
    expect(h.store.listOperations({ sessionId: SCOPE.sessionId, status: "started" }))
      .toMatchObject([{ kind: "ios_simulator_input" }]);
    const operation = h.store.listOperations({ sessionId: SCOPE.sessionId })[0]!;
    expect(JSON.stringify(operation.body)).not.toContain("xRatio");
    await h.touch.advance(SCOPE, instanceRoute, gestureId, "move", 1,
      { xRatio: 0.4, yRatio: 0.5 });
    expect(h.contact.move).toHaveBeenCalledWith({ x: 0.5, y: 0.6 }, 1, undefined);
    await h.touch.advance(SCOPE, instanceRoute, gestureId, "end", 2,
      { xRatio: 0.7, yRatio: 0.8 });
    expect(h.contact.end).toHaveBeenCalledWith({ x: 0.8, y: 0.30000000000000004 }, 2, undefined);
    expect(h.store.findOperation(operation.id)?.status).toBe("completed");
    expect(h.contact.forceRelease).not.toHaveBeenCalled();
  } finally { h.store.close(); }
});

it("allows one-shot fallback only when native begin was definitely not dispatched", async () => {
  const h = fixture();
  const gestureId = randomUUID();
  try {
    h.driver.probeNativeLiveInput.mockResolvedValueOnce(false);
    await expect(h.touch.begin(SCOPE, route(h.instance), gestureId, POINT,
      randomUUID(), VIEWPORT, "PORTRAIT"))
      .rejects.toMatchObject({ code: "NATIVE_INPUT_UNAVAILABLE" });
    expect(h.store.listOperations({ sessionId: SCOPE.sessionId })).toEqual([]);
    h.driver.beginNativeLiveTouch.mockRejectedValueOnce(new SimulatorNativeHidError(
      "INPUT_OUTCOME_UNKNOWN", "Native begin was sent."));
    await expect(h.touch.begin(SCOPE, route(h.instance), gestureId, POINT,
      randomUUID(), VIEWPORT, "PORTRAIT"))
      .rejects.toMatchObject({ code: "INPUT_OUTCOME_UNKNOWN" });
    expect(h.store.listOperations({ sessionId: SCOPE.sessionId })[0]?.status).toBe("failed");
    expect(h.screen.invalidateInteraction).toHaveBeenCalledOnce();
  } finally { h.store.close(); }
});

it("fails a contact on skipped sequence and force-releases on route teardown", async () => {
  const h = fixture();
  const first = randomUUID();
  const second = randomUUID();
  try {
    await h.touch.begin(SCOPE, route(h.instance), first, POINT,
      randomUUID(), VIEWPORT, "PORTRAIT");
    await expect(h.touch.advance(SCOPE, route(h.instance), first, "move", 2, POINT))
      .rejects.toMatchObject({ code: "INPUT_OUTCOME_UNKNOWN" });
    expect(h.contact.forceRelease).toHaveBeenCalledOnce();
    await h.touch.begin(SCOPE, route(h.instance), second, POINT,
      randomUUID(), VIEWPORT, "PORTRAIT");
    h.touch.clearInstance(h.instance.instanceId);
    expect(h.contact.forceRelease).toHaveBeenCalledTimes(2);
    expect(h.store.listOperations({ sessionId: SCOPE.sessionId, status: "started" })).toEqual([]);
  } finally { h.store.close(); }
});

it("does not start a live contact while another Simulator effect owns the durable mutex", async () => {
  const h = fixture();
  try {
    const prior = h.store.claimDeferredEffectOperation({ id: "simulator-state:fixture",
      kind: "ios_simulator_state_control", body: { sessionId: SCOPE.sessionId,
        action: "fixture" } });
    await expect(h.touch.begin(SCOPE, route(h.instance), randomUUID(), POINT,
      randomUUID(), VIEWPORT, "PORTRAIT"))
      .rejects.toMatchObject({ code: "MUTATION_IN_PROGRESS" });
    expect(h.driver.beginNativeLiveTouch).not.toHaveBeenCalled();
    expect(h.store.listOperations({ sessionId: SCOPE.sessionId, status: "started" }))
      .toHaveLength(1);
    h.store.failEffectOperation(prior.operation.id, prior.operation.bodyHash,
      { code: "fixture", message: "Finished fixture." });
  } finally { h.store.close(); }
});
