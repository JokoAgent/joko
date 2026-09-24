import { OperationalStore } from "@joko/store";
import { WdaClientError, type WdaPoint } from "@joko/tool-ios-simulator";
import { expect, it } from "vitest";
import { SimulatorInputCoordinator, type SimulatorInputAction } from "./ios-simulator-input-coordinator.js";
import { SimulatorOwnershipRegistry, type PublicSimulatorInstance } from "./ios-simulator-ownership.js";
import { SimulatorScreenObservationCoordinator } from "./ios-simulator-screen-observation.js";

const SCOPE = { sessionId: "input-task", targetId: "local", generation: 1 } as const;
const UDID = "A0123456-1234-1234-1234-123456789ABC";
const DEVICE = { udid: UDID, name: "iPhone", state: "Booted", isAvailable: true,
  runtimeIdentifier: "com.apple.CoreSimulator.SimRuntime.iOS-19-0", runtimeName: "iOS 19.0",
  runtimeVersion: "19.0", deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-17",
  lastBootedAt: null } as const;

function route(instance: PublicSimulatorInstance) {
  return { instanceId: instance.instanceId, generation: instance.generation, leaseId: instance.lease.id };
}

function authority(char: string) {
  return { effectIdentity: char.repeat(64), requestBodyHash: `sha256:${char.repeat(64)}`,
    providerGeneration: 1 };
}

function fixture() {
  const store = new OperationalStore(":memory:");
  store.upsertBackend({ id: "pi", displayName: "Pi", version: "fixture", health: "healthy",
    adapterKind: "fixture", instanceGeneration: 0, installationState: "installed",
    authenticationState: "not_required", capabilities: new Map(), models: [], tools: [], diagnostics: [] });
  store.upsertTarget({ id: "local", backendId: "pi", displayName: "Local workspace",
    workspaceRoot: "D:/workspace", managed: false, trusted: true });
  store.createSession({ id: SCOPE.sessionId, backendId: "pi", targetId: SCOPE.targetId,
    title: "Input task", binding: { opaqueRef: "input-task", generation: 1 }, pinned: false,
    archived: false, permissionMode: "ask", planMode: false, fastMode: false,
    createdAt: 1, updatedAt: 1 });
  const ownership = new SimulatorOwnershipRegistry(store);
  const bound = ownership.bindExternalDevice(SCOPE, DEVICE);
  const instance = ownership.attachViewer(SCOPE, route(bound));
  let tree: unknown = { type: "XCUIElementTypeButton", label: "Continue", enabled: true,
    visible: true, rect: { x: 10, y: 20, width: 100, height: 40 } };
  let ready = true;
  const calls: Array<{ type: string; value?: unknown }> = [];
  let tap = async (target: WdaPoint): Promise<void> => { calls.push({ type: "tap", value: target }); };
  const driver = {
    isReady: () => ready,
    observeAccessibilityTree: async () => ({ capturedAt: new Date().toISOString(), tree }),
    observeViewport: async () => ({ width: 393, height: 852, orientation: "PORTRAIT" as const }),
    tap: (_instance: PublicSimulatorInstance, target: WdaPoint) => tap(target),
    swipe: async (_instance: PublicSimulatorInstance, start: WdaPoint, end: WdaPoint,
      durationMs: number) => { calls.push({ type: "swipe", value: { start, end, durationMs } }); },
    typeText: async (_instance: PublicSimulatorInstance, text: string) => {
      calls.push({ type: "type_text", value: text });
    },
    pressHome: async () => { calls.push({ type: "press_home" }); }
  };
  const screen = new SimulatorScreenObservationCoordinator(ownership, driver);
  const input = new SimulatorInputCoordinator(store, ownership, driver, screen, { now: () => 1_000 });
  return { store, ownership, instance, screen, input, calls,
    setTree: (value: unknown) => { tree = value; },
    setReady: (value: boolean) => { ready = value; },
    setTap: (value: typeof tap) => { tap = value; } };
}

const OBSERVE_NONE = { mode: "none", timeoutMs: 3_000, stableForMs: 300 } as const;

it("claims public input before dispatch, resolves the current element and never persists typed text", async () => {
  const h = fixture();
  try {
    const initial = (await h.screen.screenMap(SCOPE, route(h.instance))).screenMap;
    const elementId = initial.elements[0]!.elementId;
    h.setTree({ type: "XCUIElementTypeButton", label: "Tapped", enabled: true,
      visible: true, rect: { x: 10, y: 20, width: 100, height: 40 } });
    const tapped = await h.input.execute(SCOPE, route(h.instance),
      { type: "tap", snapshotId: initial.snapshotId, target: { elementId } },
      { mode: "immediate", timeoutMs: 3_000, stableForMs: 300 }, authority("a"));
    expect(tapped).toMatchObject({ replayed: false, receipt: {
      action: "tap", backend: "wda", observationResult: { state: "captured" }
    }, observation: { mode: "immediate", screenMap: { elements: [{ label: "Tapped" }] } } });
    expect(h.calls).toEqual([{ type: "tap", value: { x: 60, y: 40 } }]);
    const replay = await h.input.execute(SCOPE, route(h.instance),
      { type: "tap", snapshotId: initial.snapshotId, target: { elementId } },
      { mode: "immediate", timeoutMs: 3_000, stableForMs: 300 }, authority("a"));
    expect(replay).toMatchObject({ replayed: true, observation: null });
    expect(h.calls).toHaveLength(1);
    await expect(h.input.execute(SCOPE, route(h.instance),
      { type: "press_home", snapshotId: initial.snapshotId }, OBSERVE_NONE, authority("b")))
      .rejects.toMatchObject({ code: "STALE_UI_SNAPSHOT" });

    const current = (await h.screen.screenMap(SCOPE, route(h.instance))).screenMap;
    const secret = "typed-secret-must-stay-ephemeral";
    await expect(h.input.execute(SCOPE, route(h.instance),
      { type: "type_text", snapshotId: current.snapshotId, text: secret },
      OBSERVE_NONE, authority("c"))).resolves.toMatchObject({ receipt: {
        action: "type_text", observationResult: { state: "not_requested" }
      } });
    const operation = h.store.findOperation(`ios-simulator-input:${"c".repeat(64)}`);
    expect(operation?.status).toBe("completed");
    expect(JSON.stringify({ body: operation?.body,
      response: operation && "response" in operation ? operation.response : null })).not.toContain(secret);
    expect(h.calls.at(-1)).toEqual({ type: "type_text", value: secret });
  } finally { h.store.close(); }
});

it("serializes input effects and fences an unknown dispatch without reusing its snapshot", async () => {
  const h = fixture();
  try {
    const initial = (await h.screen.screenMap(SCOPE, route(h.instance))).screenMap;
    let dispatched = 0;
    h.setTap(async () => { dispatched += 1;
      throw new WdaClientError("INPUT_OUTCOME_UNKNOWN", "private upstream detail"); });
    const action: SimulatorInputAction = { type: "tap", snapshotId: initial.snapshotId,
      target: { x: 1, y: 2 } };
    await expect(h.input.execute(SCOPE, route(h.instance), action, OBSERVE_NONE, authority("d")))
      .rejects.toMatchObject({ code: "INPUT_OUTCOME_UNKNOWN" });
    expect(dispatched).toBe(1);
    expect(h.store.findOperation(`ios-simulator-input:${"d".repeat(64)}`)?.status).toBe("failed");
    expect(() => h.screen.requireInteractionSnapshot(SCOPE, route(h.instance), initial.snapshotId))
      .toThrow(/new screen map/u);
    await expect(h.input.execute(SCOPE, route(h.instance), action, OBSERVE_NONE, authority("d")))
      .rejects.toMatchObject({ code: "INPUT_OUTCOME_UNKNOWN" });
    expect(dispatched).toBe(1);

    const current = (await h.screen.screenMap(SCOPE, route(h.instance))).screenMap;
    const blocker = h.store.claimDeferredEffectOperation({ id: "simulator-input-blocker",
      kind: "ios_simulator_input", body: { sessionId: SCOPE.sessionId } });
    await expect(h.input.execute(SCOPE, route(h.instance),
      { type: "press_home", snapshotId: current.snapshotId }, OBSERVE_NONE, authority("e")))
      .rejects.toMatchObject({ code: "MUTATION_IN_PROGRESS" });
    h.store.failEffectOperation(blocker.operation.id, blocker.operation.bodyHash,
      new Error("Controlled test interruption."));
  } finally { h.store.close(); }
});

it("commits confirmed input even when its requested observation is cancelled", async () => {
  const h = fixture();
  const controller = new AbortController();
  try {
    const initial = (await h.screen.screenMap(SCOPE, route(h.instance))).screenMap;
    h.setTap(async target => { h.calls.push({ type: "tap", value: target }); controller.abort(); });
    const result = await h.input.execute(SCOPE, route(h.instance),
      { type: "tap", snapshotId: initial.snapshotId, target: { x: 10, y: 20 } },
      { mode: "immediate", timeoutMs: 3_000, stableForMs: 300 }, authority("f"), controller.signal);
    expect(result).toMatchObject({ replayed: false, receipt: {
      observationResult: { state: "failed", reasonCode: "OBSERVATION_CANCELLED" }
    }, observation: null, observationError: { code: "OBSERVATION_CANCELLED" } });
    expect(h.store.findOperation(`ios-simulator-input:${"f".repeat(64)}`)?.status).toBe("completed");
  } finally { h.store.close(); }
});
