import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SimulatorLifecycleError, type SimulatorDevice, type SimulatorLifecycleRuntime } from "@joko/tool-ios-simulator";
import { OperationalStore } from "@joko/store";
import { expect, it } from "vitest";
import { SimulatorLifecycleCoordinator, type SimulatorLifecycleEffectAuthority } from "./ios-simulator-lifecycle-coordinator.js";
import { SimulatorOwnershipRegistry, type SimulatorInstanceRoute } from "./ios-simulator-ownership.js";

const DEVICE: SimulatorDevice = {
  udid: "A0123456-1234-1234-1234-123456789ABC", name: "iPhone test", state: "Shutdown", isAvailable: true,
  runtimeIdentifier: "com.apple.CoreSimulator.SimRuntime.iOS-19-0", runtimeName: "iOS 19.0", runtimeVersion: "19.0",
  deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-17", lastBootedAt: null
};
const SCOPE = { sessionId: "first", targetId: "target", generation: 1 } as const;
const authority = (letter: string): SimulatorLifecycleEffectAuthority => ({
  effectIdentity: letter.repeat(64), requestBodyHash: `sha256:${letter.repeat(64)}`, providerGeneration: 1
});
const route = (instance: { readonly instanceId: string; readonly generation: number; readonly lease: { readonly id: string } }): SimulatorInstanceRoute => ({
  instanceId: instance.instanceId, generation: instance.generation, leaseId: instance.lease.id
});

function seed(store: OperationalStore): SimulatorOwnershipRegistry {
  store.upsertBackend({ id: "pi", displayName: "Pi", version: "fixture", health: "healthy", adapterKind: "fixture",
    instanceGeneration: 0, installationState: "installed", authenticationState: "not_required",
    capabilities: new Map(), models: [], tools: [], diagnostics: [] });
  store.upsertTarget({ id: "target", backendId: "pi", displayName: "Local workspace",
    workspaceRoot: "D:/workspace", managed: false, trusted: true });
  for (const id of ["first", "second"]) store.createSession({ id, backendId: "pi", targetId: "target", title: id,
    binding: { opaqueRef: id, generation: 1 }, pinned: false, archived: false,
    permissionMode: "ask", planMode: false, fastMode: false, createdAt: 1, updatedAt: 1 });
  return new SimulatorOwnershipRegistry(store);
}

it("claims before exact simctl effects and atomically commits route generations with durable replay", async () => {
  const store = new OperationalStore(":memory:");
  try {
    const ownership = seed(store);
    const attached = ownership.bindExternalDevice(SCOPE, DEVICE);
    let state = "Shutdown";
    const mutations: string[] = [];
    const runtime: SimulatorLifecycleRuntime = {
      findExact: async () => ({ ...DEVICE, state }),
      bootExact: async () => {
        expect(store.listOperations({ sessionId: "first", status: "started" })).toHaveLength(1);
        mutations.push("boot"); state = "Booted"; return { ...DEVICE, state };
      },
      shutdownExact: async () => {
        expect(store.listOperations({ sessionId: "first", status: "started" })).toHaveLength(1);
        mutations.push("shutdown"); state = "Shutdown";
      }
    };
    const coordinator = new SimulatorLifecycleCoordinator(store, ownership, runtime);
    await expect(coordinator.start(SCOPE, route(attached), { ...authority("a"), effectIdentity: "missing" }))
      .rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(store.listOperations({ sessionId: "first" })).toEqual([]);
    const started = await coordinator.start(SCOPE, route(attached), authority("a"));
    expect(started).toMatchObject({ replayed: false, instance: { generation: 2, lifecycleState: "ready",
      bootProvenance: "agent_booted", viewerState: "detached", healthState: "healthy" } });
    expect(store.listOperations({ sessionId: "first" })[0]).toMatchObject({ status: "completed", kind: "ios_simulator_lifecycle" });
    expect(await coordinator.start(SCOPE, route(attached), authority("a"))).toEqual({ ...started, replayed: true });
    expect(mutations).toEqual(["boot"]);
    await expect(coordinator.stop(SCOPE, route(attached), authority("b"))).rejects.toThrow(/stale/u);
    await expect(coordinator.start({ ...SCOPE, sessionId: "second" }, route(started.instance), authority("c"))).rejects.toThrow(/stale/u);
    expect(mutations).toEqual(["boot"]);
    const stopped = await coordinator.stop(SCOPE, route(started.instance), authority("d"));
    expect(stopped.instance).toMatchObject({ generation: 3, lifecycleState: "stopped", healthState: "healthy" });
    expect(mutations).toEqual(["boot", "shutdown"]);
  } finally { store.close(); }
});

it("does not commit a boot when cancellation or the exact workspace owner changes after dispatch", async () => {
  for (const failure of ["cancel", "workspace"] as const) {
    const store = new OperationalStore(":memory:");
    try {
      const ownership = seed(store);
      const attached = ownership.bindExternalDevice(SCOPE, DEVICE);
      const controller = new AbortController();
      let state = "Shutdown";
      const runtime: SimulatorLifecycleRuntime = {
        findExact: async () => ({ ...DEVICE, state }),
        bootExact: async () => {
          state = "Booted";
          if (failure === "cancel") controller.abort();
          else store.upsertTarget({ ...store.getTarget("target").descriptor, workspaceRoot: "D:/changed" });
          return { ...DEVICE, state };
        },
        shutdownExact: async () => undefined
      };
      const coordinator = new SimulatorLifecycleCoordinator(store, ownership, runtime);
      await expect(coordinator.start(SCOPE, route(attached), authority("e"), controller.signal))
        .rejects.toMatchObject({ code: "SIMULATOR_BOOT_UNKNOWN" });
      expect(store.listOperations({ sessionId: "first" }).find(item => item.kind === "ios_simulator_lifecycle"))
        .toMatchObject({ status: "failed" });
      if (failure === "cancel") {
        expect(ownership.listForTask(SCOPE)[0]).toMatchObject({ lifecycleState: "error", healthState: "degraded" });
      } else {
        expect(() => ownership.listForTask(SCOPE)).toThrow(/no longer matches/u);
      }
    } finally { store.close(); }
  }
});

it("fences concurrent requests and rotates the route after an uncertain side effect", async () => {
  const store = new OperationalStore(":memory:");
  try {
    const ownership = seed(store);
    const attached = ownership.bindExternalDevice(SCOPE, DEVICE);
    let entered!: () => void;
    const bootEntered = new Promise<void>(resolve => { entered = resolve; });
    let release!: () => void;
    const releaseBoot = new Promise<void>(resolve => { release = resolve; });
    let state = "Shutdown";
    let bootCalls = 0;
    const runtime: SimulatorLifecycleRuntime = {
      findExact: async () => ({ ...DEVICE, state }),
      bootExact: async () => {
        bootCalls += 1;
        if (bootCalls === 1) {
          entered(); await releaseBoot;
          state = "Booted";
          throw new SimulatorLifecycleError("SIMULATOR_BOOT_UNKNOWN", "Simulator command outcome is unknown.");
        }
        return { ...DEVICE, state };
      },
      shutdownExact: async () => { throw new Error("unexpected shutdown"); }
    };
    const coordinator = new SimulatorLifecycleCoordinator(store, ownership, runtime);
    const pending = coordinator.start(SCOPE, route(attached), authority("a"));
    await bootEntered;
    await expect(coordinator.start(SCOPE, route(attached), authority("b"))).rejects.toThrow(/in progress/u);
    expect(bootCalls).toBe(1);
    release();
    await expect(pending).rejects.toMatchObject({ code: "SIMULATOR_BOOT_UNKNOWN" });
    expect(store.listOperations({ sessionId: "first" }).filter(item => item.kind === "ios_simulator_lifecycle"))
      .toMatchObject([{ status: "failed" }]);
    const failed = ownership.listForTask(SCOPE)[0]!;
    expect(failed).toMatchObject({ generation: 2, lifecycleState: "error", healthState: "degraded",
      errorCode: "SIMULATOR_BOOT_UNKNOWN" });
    await expect(coordinator.start(SCOPE, route(attached), authority("a"))).rejects.toThrow(/previously failed/u);
    const observed = await coordinator.start(SCOPE, route(failed), authority("c"));
    expect(observed.instance).toMatchObject({ generation: 3, lifecycleState: "ready", bootProvenance: "preexisting" });
  } finally { store.close(); }
});

it("tombstones a crash-interrupted claim after SQLite reopen and allows only a new observed request", async () => {
  const directory = await mkdtemp(join(tmpdir(), "joko-simulator-lifecycle-"));
  const database = join(directory, "store.db");
  let store: OperationalStore | undefined;
  try {
    store = new OperationalStore(database);
    const ownership = seed(store);
    const attached = ownership.bindExternalDevice(SCOPE, DEVICE);
    let entered!: () => void;
    const bootEntered = new Promise<void>(resolve => { entered = resolve; });
    const interrupted: SimulatorLifecycleRuntime = {
      findExact: async () => DEVICE,
      bootExact: async () => { entered(); return new Promise<SimulatorDevice>(() => undefined); },
      shutdownExact: async () => undefined
    };
    void new SimulatorLifecycleCoordinator(store, ownership, interrupted).start(SCOPE, route(attached), authority("a"));
    await bootEntered;
    expect(store.listOperations({ sessionId: "first", status: "started" })).toHaveLength(1);
    store.close();
    store = new OperationalStore(database);
    expect(store.recoverStartup("simulator-recovery").recoveredEffectOperationIds).toHaveLength(1);
    const restored = new SimulatorOwnershipRegistry(store);
    const recovered = restored.listForTask(SCOPE)[0]!;
    expect(recovered).toMatchObject({ generation: 2, lifecycleState: "error", healthState: "degraded",
      errorCode: "EFFECT_OUTCOME_UNKNOWN" });
    let bootCalls = 0;
    let state = "Shutdown";
    const runtime: SimulatorLifecycleRuntime = {
      findExact: async () => ({ ...DEVICE, state }),
      bootExact: async () => { bootCalls += 1; state = "Booted"; return { ...DEVICE, state }; },
      shutdownExact: async () => undefined
    };
    const coordinator = new SimulatorLifecycleCoordinator(store, restored, runtime);
    await expect(coordinator.start(SCOPE, route(attached), authority("a"))).rejects.toThrow(/previously failed/u);
    expect(bootCalls).toBe(0);
    const result = await coordinator.start(SCOPE, route(recovered), authority("b"));
    expect(result.instance).toMatchObject({ generation: 3, lifecycleState: "ready" });
    expect(bootCalls).toBe(1);
  } finally {
    store?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
