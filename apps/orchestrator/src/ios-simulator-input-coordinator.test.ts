import { OperationalStore } from "@joko/store";
import { SimulatorNativeHidError, WdaClientError, type WdaPoint } from "@joko/tool-ios-simulator";
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
  let typeText = async (text: string): Promise<void> => { calls.push({ type: "type_text", value: text }); };
  let nativeReady = false;
  let nativeTouch = async (first: readonly unknown[], second: readonly unknown[] | undefined): Promise<void> => {
    calls.push({ type: "native_touch", value: { first, second } });
  };
  const driver = {
    isReady: () => ready,
    observeAccessibilityTree: async () => ({ capturedAt: new Date().toISOString(), tree }),
    observeViewport: async () => ({ width: 393, height: 852, orientation: "PORTRAIT" as const }),
    tap: (_instance: PublicSimulatorInstance, target: WdaPoint) => tap(target),
    swipe: async (_instance: PublicSimulatorInstance, start: WdaPoint, end: WdaPoint,
      durationMs: number) => { calls.push({ type: "swipe", value: { start, end, durationMs } }); },
    typeText: (_instance: PublicSimulatorInstance, text: string) => typeText(text),
    pressHome: async () => { calls.push({ type: "press_home" }); },
    probeNativeInput: async () => nativeReady,
    touchNativePath: (_instance: PublicSimulatorInstance, first: readonly unknown[],
      second?: readonly unknown[]) => nativeTouch(first, second)
  };
  const screen = new SimulatorScreenObservationCoordinator(ownership, driver);
  const input = new SimulatorInputCoordinator(store, ownership, driver, screen, { now: () => 1_000 });
  return { store, ownership, instance, screen, input, calls,
    setTree: (value: unknown) => { tree = value; },
    setReady: (value: boolean) => { ready = value; },
    setTap: (value: typeof tap) => { tap = value; },
    setTypeText: (value: typeof typeText) => { typeText = value; },
    setNativeReady: (value: boolean) => { nativeReady = value; },
    setNativeTouch: (value: typeof nativeTouch) => { nativeTouch = value; } };
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

it("replays request-bound Viewer input across a refreshed private snapshot without redispatch", async () => {
  const h = fixture();
  try {
    const first = (await h.screen.screenMap(SCOPE, route(h.instance))).screenMap;
    const secret = "viewer text stays outside the operation";
    await expect(h.input.execute(SCOPE, route(h.instance),
      { type: "type_text", snapshotId: first.snapshotId, text: secret },
      OBSERVE_NONE, authority("0"), undefined, { bindSnapshotToOperation: false }))
      .resolves.toMatchObject({ replayed: false });
    const second = (await h.screen.screenMap(SCOPE, route(h.instance))).screenMap;
    await expect(h.input.execute(SCOPE, route(h.instance),
      { type: "type_text", snapshotId: second.snapshotId, text: secret },
      OBSERVE_NONE, authority("0"), undefined, { bindSnapshotToOperation: false }))
      .resolves.toMatchObject({ replayed: true, observation: null });
    expect(h.calls.filter(call => call.type === "type_text" && call.value === secret)).toHaveLength(1);
    const operation = h.store.findOperation(`ios-simulator-input:${"0".repeat(64)}`);
    expect(operation?.body).not.toHaveProperty("snapshotId");
    expect(JSON.stringify({ body: operation?.body,
      response: operation && "response" in operation ? operation.response : null })).not.toContain(secret);
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

it("runs drag, long-press, key and a bounded batch against successive current snapshots", async () => {
  const h = fixture();
  try {
    const initial = (await h.screen.screenMap(SCOPE, route(h.instance))).screenMap;
    const elementId = initial.elements[0]!.elementId;
    const drag = await h.input.execute(SCOPE, route(h.instance), { type: "drag",
      snapshotId: initial.snapshotId, fromElementId: elementId, toElementId: elementId, durationMs: 500 },
    { mode: "immediate", timeoutMs: 3_000, stableForMs: 300 }, authority("1"));
    expect(h.calls.at(-1)).toEqual({ type: "swipe", value: {
      start: { x: 60, y: 40 }, end: { x: 60, y: 40 }, durationMs: 500
    } });
    const afterDrag = drag.observation!.screenMap;
    const held = await h.input.execute(SCOPE, route(h.instance), { type: "long_press",
      snapshotId: afterDrag.snapshotId, elementId, durationMs: 750 },
    { mode: "immediate", timeoutMs: 3_000, stableForMs: 300 }, authority("2"));
    expect(h.calls.at(-1)).toEqual({ type: "swipe", value: {
      start: { x: 60, y: 40 }, end: { x: 60, y: 40 }, durationMs: 750
    } });
    const afterHold = held.observation!.screenMap;
    const keyed = await h.input.execute(SCOPE, route(h.instance), { type: "key_press",
      snapshotId: afterHold.snapshotId, key: "return" },
    { mode: "immediate", timeoutMs: 3_000, stableForMs: 300 }, authority("3"));
    expect(h.calls.at(-1)).toEqual({ type: "type_text", value: "\uE007" });
    const afterKey = keyed.observation!.screenMap;
    const secret = "batch-text-must-not-persist";
    const batch = await h.input.execute(SCOPE, route(h.instance), { type: "batch",
      snapshotId: afterKey.snapshotId, actions: [
        { type: "tap", elementId }, { type: "type_text", text: secret },
        { type: "key_press", key: "tab" }
      ] }, { mode: "immediate", timeoutMs: 3_000, stableForMs: 300 }, authority("4"));
    expect(batch).toMatchObject({ receipt: { action: "batch", completed: [
      { index: 0, type: "tap", backend: "wda" },
      { index: 1, type: "type_text", backend: "wda" },
      { index: 2, type: "key_press", backend: "wda" }
    ], observationResult: { state: "captured" } }, observation: { mode: "immediate" } });
    expect(h.calls.slice(-3)).toEqual([
      { type: "tap", value: { x: 60, y: 40 } },
      { type: "type_text", value: secret }, { type: "type_text", value: "\uE004" }
    ]);
    const operation = h.store.findOperation(`ios-simulator-input:${"4".repeat(64)}`);
    expect(JSON.stringify({ body: operation?.body,
      response: operation && "response" in operation ? operation.response : null })).not.toContain(secret);
  } finally { h.store.close(); }
});

it("stops a partially completed batch and fences the whole effect from replay", async () => {
  const h = fixture();
  let calls = 0;
  h.setTypeText(async text => {
    calls += 1;
    h.calls.push({ type: "type_text", value: text });
    if (calls === 2) throw new WdaClientError("INVALID_SESSION", "Driver session changed.");
  });
  try {
    const initial = (await h.screen.screenMap(SCOPE, route(h.instance))).screenMap;
    const action = { type: "batch" as const, snapshotId: initial.snapshotId, actions: [
      { type: "type_text" as const, text: "first" },
      { type: "type_text" as const, text: "second" },
      { type: "type_text" as const, text: "must-not-run" }
    ] };
    await expect(h.input.execute(SCOPE, route(h.instance), action,
      { mode: "stable", timeoutMs: 1_000, stableForMs: 100 }, authority("5")))
      .rejects.toMatchObject({ code: "INPUT_OUTCOME_UNKNOWN" });
    expect(h.calls.map(item => item.value)).toEqual(["first", "second"]);
    expect(h.store.findOperation(`ios-simulator-input:${"5".repeat(64)}`)?.status).toBe("failed");
    await expect(h.input.execute(SCOPE, route(h.instance), action,
      { mode: "stable", timeoutMs: 1_000, stableForMs: 100 }, authority("5")))
      .rejects.toMatchObject({ code: "INPUT_OUTCOME_UNKNOWN" });
    expect(h.calls).toHaveLength(2);
  } finally { h.store.close(); }
});

it("requires native admission and dispatches bounded continuous and synchronized paths", async () => {
  const h = fixture();
  const first = [{ phase: "down", x: 10, y: 20 },
    { phase: "move", x: 20, y: 30, dtMs: 16 }, { phase: "up", x: 30, y: 40, dtMs: 16 }];
  const second = [{ phase: "down", x: 100, y: 200 },
    { phase: "move", x: 120, y: 230, dtMs: 16 }, { phase: "up", x: 130, y: 240, dtMs: 16 }];
  try {
    const initial = (await h.screen.screenMap(SCOPE, route(h.instance))).screenMap;
    expect(await h.input.nativeInputAvailable([h.instance])).toBe(false);
    await expect(h.input.execute(SCOPE, route(h.instance),
      { type: "touch_path", snapshotId: initial.snapshotId, points: first, edge: "none" },
      OBSERVE_NONE, authority("6"))).rejects.toMatchObject({ code: "NATIVE_INPUT_UNAVAILABLE" });
    expect(h.calls).toEqual([]);
    h.setNativeReady(true);
    expect(await h.input.nativeInputAvailable([h.instance])).toBe(true);
    const refreshed = (await h.screen.screenMap(SCOPE, route(h.instance))).screenMap;
    const single = await h.input.execute(SCOPE, route(h.instance),
      { type: "touch_path", snapshotId: refreshed.snapshotId, points: first, edge: "left" },
      { mode: "immediate", timeoutMs: 1_000, stableForMs: 100 }, authority("7"));
    expect(single).toMatchObject({ receipt: { action: "touch_path", backend: "native-hid",
      observationResult: { state: "captured" } }, replayed: false,
    observation: { mode: "immediate" } });
    expect(h.calls[0]?.type).toBe("native_touch");
    const firstCall = h.calls[0]?.value as { first: readonly { phase: string; x: number;
      y: number; edge: string }[] };
    expect(firstCall.first[0]).toMatchObject({ phase: "down", x: 10 / 393,
      y: 20 / 852, edge: "left" });
    const next = single.observation!.screenMap;
    const paired = await h.input.execute(SCOPE, route(h.instance),
      { type: "touch2_path", snapshotId: next.snapshotId, first, second },
      OBSERVE_NONE, authority("8"));
    expect(paired.receipt).toMatchObject({ action: "touch2_path", backend: "native-hid" });
    expect(h.calls[1]).toMatchObject({ type: "native_touch", value: {
      second: expect.any(Array) } });
    const operation = h.store.findOperation(`ios-simulator-input:${"8".repeat(64)}`);
    expect(JSON.stringify(operation?.body)).not.toContain('"points"');
    expect(JSON.stringify(operation?.body)).not.toContain('"first"');
    expect(JSON.stringify(operation?.body)).not.toContain('"second"');
  } finally { h.store.close(); }
});

it("rejects unsynchronized fingers before admission and never retries uncertain native touch", async () => {
  const h = fixture();
  h.setNativeReady(true);
  let dispatched = 0;
  h.setNativeTouch(async () => { dispatched += 1;
    throw new SimulatorNativeHidError("INPUT_OUTCOME_UNKNOWN", "Native touch outcome is unknown."); });
  const first = [{ phase: "down", x: 10, y: 20 },
    { phase: "move", x: 20, y: 30 }, { phase: "up", x: 30, y: 40 }];
  try {
    const initial = (await h.screen.screenMap(SCOPE, route(h.instance))).screenMap;
    await expect(h.input.execute(SCOPE, route(h.instance),
      { type: "touch2_path", snapshotId: initial.snapshotId, first,
        second: [first[0], { ...first[1], dtMs: 20 }, first[2]] },
      OBSERVE_NONE, authority("9"))).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(h.store.findOperation(`ios-simulator-input:${"9".repeat(64)}`)).toBeFalsy();
    const action = { type: "touch_path" as const, snapshotId: initial.snapshotId,
      points: first, edge: "none" as const };
    await expect(h.input.execute(SCOPE, route(h.instance), action,
      OBSERVE_NONE, authority("a"))).rejects.toMatchObject({ code: "INPUT_OUTCOME_UNKNOWN" });
    await expect(h.input.execute(SCOPE, route(h.instance), action,
      OBSERVE_NONE, authority("a"))).rejects.toMatchObject({ code: "INPUT_OUTCOME_UNKNOWN" });
    expect(dispatched).toBe(1);
  } finally { h.store.close(); }
});
