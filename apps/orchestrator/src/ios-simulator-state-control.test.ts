import { OperationalStore } from "@joko/store";
import { SimulatorLifecycleError, WdaClientError,
  type SimulatorAppearance, type SimulatorContentSize } from "@joko/tool-ios-simulator";
import { expect, it } from "vitest";
import { SimulatorOwnershipRegistry, type PublicSimulatorInstance } from "./ios-simulator-ownership.js";
import { SimulatorScreenObservationCoordinator } from "./ios-simulator-screen-observation.js";
import { SimulatorStateControlCoordinator } from "./ios-simulator-state-control.js";

const SCOPE = { sessionId: "state-task", targetId: "local", generation: 1 } as const;
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
    title: "State task", binding: { opaqueRef: "state-task", generation: 1 }, pinned: false,
    archived: false, permissionMode: "ask", planMode: false, fastMode: false,
    createdAt: 1, updatedAt: 1 });
  const ownership = new SimulatorOwnershipRegistry(store);
  const instance = ownership.attachViewer(SCOPE, route(ownership.bindExternalDevice(SCOPE, DEVICE)));
  const calls: Array<{ type: string; value: unknown; claimed: boolean }> = [];
  let orientation = async (value: "PORTRAIT" | "LANDSCAPE") => {
    calls.push({ type: "orientation", value, claimed: hasClaim(store) });
    return { width: 852, height: 393, orientation: value } as const;
  };
  let appearance = async (value: SimulatorAppearance) => {
    calls.push({ type: "appearance", value, claimed: hasClaim(store) });
  };
  const driver = {
    isReady: () => true,
    observeAccessibilityTree: async () => ({ capturedAt: new Date().toISOString(),
      tree: { type: "XCUIElementTypeButton", label: "Continue", enabled: true,
        visible: true, rect: { x: 10, y: 20, width: 100, height: 40 } } }),
    observeViewport: async () => ({ width: 393, height: 852, orientation: "PORTRAIT" as const }),
    setOrientation: (_instance: PublicSimulatorInstance, value: "PORTRAIT" | "LANDSCAPE") =>
      orientation(value)
  };
  const screen = new SimulatorScreenObservationCoordinator(ownership, driver);
  const lifecycle = {
    setAppearance: (_udid: string, value: SimulatorAppearance) => appearance(value),
    setIncreaseContrast: async (_udid: string, value: boolean) => {
      calls.push({ type: "contrast", value, claimed: hasClaim(store) });
    },
    setContentSize: async (_udid: string, value: SimulatorContentSize) => {
      calls.push({ type: "content_size", value, claimed: hasClaim(store) });
    }
  };
  const state = new SimulatorStateControlCoordinator(store, ownership, driver, screen, lifecycle,
    { now: () => 1_000 });
  return { store, ownership, instance, screen, state, calls,
    setOrientation: (value: typeof orientation) => { orientation = value; },
    setAppearance: (value: typeof appearance) => { appearance = value; } };
}

function hasClaim(store: OperationalStore): boolean {
  return store.listOperations({ sessionId: SCOPE.sessionId, status: "started" })
    .some(operation => operation.kind === "ios_simulator_state_control");
}

it("claims each state change, rotates from the current snapshot and does not replay effects", async () => {
  const h = fixture();
  try {
    const initial = (await h.screen.screenMap(SCOPE, route(h.instance))).screenMap;
    const rotated = await h.state.execute(SCOPE, route(h.instance), { type: "set_orientation",
      snapshotId: initial.snapshotId, orientation: "LANDSCAPE" }, authority("a"));
    expect(rotated).toMatchObject({ replayed: false, receipt: { interaction: "set_orientation",
      backend: "wda", orientation: "LANDSCAPE", mode: "device",
      viewport: { width: 852, height: 393, orientation: "LANDSCAPE" } } });
    expect(h.calls).toEqual([{ type: "orientation", value: "LANDSCAPE", claimed: true }]);
    expect(await h.state.execute(SCOPE, route(h.instance), { type: "set_orientation",
      snapshotId: initial.snapshotId, orientation: "LANDSCAPE" }, authority("a")))
      .toMatchObject({ replayed: true });
    expect(h.calls).toHaveLength(1);
    await expect(h.state.execute(SCOPE, route(h.instance), { type: "set_orientation",
      snapshotId: initial.snapshotId, orientation: "PORTRAIT" }, authority("b")))
      .rejects.toMatchObject({ code: "STALE_UI_SNAPSHOT" });

    await h.state.execute(SCOPE, route(h.instance),
      { type: "set_appearance", appearance: "dark" }, authority("c"));
    await h.state.execute(SCOPE, route(h.instance),
      { type: "set_increase_contrast", enabled: true }, authority("d"));
    await h.state.execute(SCOPE, route(h.instance),
      { type: "set_content_size", contentSize: "accessibility-extra-large" }, authority("e"));
    expect(h.calls.slice(1)).toEqual([
      { type: "appearance", value: "dark", claimed: true },
      { type: "contrast", value: true, claimed: true },
      { type: "content_size", value: "accessibility-extra-large", claimed: true }
    ]);
    expect(h.store.listOperations({ sessionId: SCOPE.sessionId })
      .filter(operation => operation.kind === "ios_simulator_state_control")).toHaveLength(5);
  } finally { h.store.close(); }
});

it("serializes with input and fences an uncertain simctl result from replay", async () => {
  const h = fixture();
  try {
    const blocker = h.store.claimDeferredEffectOperation({ id: "state-input-blocker",
      kind: "ios_simulator_input", body: { sessionId: SCOPE.sessionId } });
    await expect(h.state.execute(SCOPE, route(h.instance),
      { type: "set_appearance", appearance: "light" }, authority("f")))
      .rejects.toMatchObject({ code: "MUTATION_IN_PROGRESS" });
    h.store.failEffectOperation(blocker.operation.id, blocker.operation.bodyHash,
      new Error("Controlled input interruption."));

    let calls = 0;
    h.setAppearance(async () => { calls += 1;
      throw new SimulatorLifecycleError("SIMULATOR_CONTROL_UNKNOWN", "private host detail"); });
    const action = { type: "set_appearance" as const, appearance: "light" as const };
    await expect(h.state.execute(SCOPE, route(h.instance), action, authority("1")))
      .rejects.toMatchObject({ code: "STATE_OUTCOME_UNKNOWN" });
    await expect(h.state.execute(SCOPE, route(h.instance), action, authority("1")))
      .rejects.toMatchObject({ code: "STATE_OUTCOME_UNKNOWN" });
    expect(calls).toBe(1);
  } finally { h.store.close(); }
});

it("preserves a definitive orientation rejection while invalidating the old snapshot", async () => {
  const h = fixture();
  try {
    const initial = (await h.screen.screenMap(SCOPE, route(h.instance))).screenMap;
    let calls = 0;
    h.setOrientation(async () => { calls += 1;
      throw new WdaClientError("ORIENTATION_UNSUPPORTED",
        "The foreground app does not support the requested orientation."); });
    const action = { type: "set_orientation" as const, snapshotId: initial.snapshotId,
      orientation: "LANDSCAPE" as const };
    await expect(h.state.execute(SCOPE, route(h.instance), action, authority("2")))
      .rejects.toMatchObject({ code: "ORIENTATION_UNSUPPORTED" });
    expect(() => h.screen.requireInteractionSnapshot(SCOPE, route(h.instance), initial.snapshotId))
      .toThrow(/new screen map/u);
    await expect(h.state.execute(SCOPE, route(h.instance), action, authority("2")))
      .rejects.toMatchObject({ code: "ORIENTATION_UNSUPPORTED" });
    expect(calls).toBe(1);
  } finally { h.store.close(); }
});
