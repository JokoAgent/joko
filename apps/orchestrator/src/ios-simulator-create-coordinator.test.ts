import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSimulatorCreateRuntime, SimulatorCreateError,
  type SimulatorCommandResult, type SimulatorCommandRunner, type SimulatorCreateRuntime,
  type SimulatorDevice, type SimulatorLifecycleRuntime
} from "@joko/tool-ios-simulator";
import { OperationalStore } from "@joko/store";
import { expect, it } from "vitest";
import { SimulatorCreateCoordinator } from "./ios-simulator-create-coordinator.js";
import { type SimulatorLifecycleEffectAuthority } from "./ios-simulator-lifecycle-coordinator.js";
import { SimulatorOwnershipRegistry } from "./ios-simulator-ownership.js";
import { SimulatorPendingCreateRegistry } from "./ios-simulator-pending-create.js";

const UDID = "A0123456-1234-1234-1234-123456789ABC";
const TEMPLATE_UDID = "B0123456-1234-1234-1234-123456789ABC";
const RUNTIME = "com.apple.CoreSimulator.SimRuntime.iOS-19-0";
const TYPE = "com.apple.CoreSimulator.SimDeviceType.iPhone-17";
const SCOPE = { sessionId: "first", targetId: "target", generation: 1 } as const;
const OTHER = { ...SCOPE, sessionId: "second" } as const;
const DEVICE: SimulatorDevice = {
  udid: TEMPLATE_UDID, name: "Template", state: "Shutdown", isAvailable: true,
  runtimeIdentifier: RUNTIME, runtimeName: "iOS 19.0", runtimeVersion: "19.0",
  deviceTypeIdentifier: TYPE, lastBootedAt: null
};
const authority = (letter: string): SimulatorLifecycleEffectAuthority => ({
  effectIdentity: letter.repeat(64), requestBodyHash: `sha256:${letter.repeat(64)}`, providerGeneration: 1
});
const input = { templateUdid: TEMPLATE_UDID, name: "Joko iPhone" } as const;

function seed(store: OperationalStore): void {
  store.upsertBackend({ id: "pi", displayName: "Pi", version: "fixture", health: "healthy", adapterKind: "fixture",
    instanceGeneration: 0, installationState: "installed", authenticationState: "not_required",
    capabilities: new Map(), models: [], tools: [], diagnostics: [] });
  store.upsertTarget({ id: "target", backendId: "pi", displayName: "Local workspace",
    workspaceRoot: "D:/workspace", managed: false, trusted: true });
  for (const id of ["first", "second"]) store.createSession({ id, backendId: "pi", targetId: "target", title: id,
    binding: { opaqueRef: id, generation: 1 }, pinned: false, archived: false,
    permissionMode: "ask", planMode: false, fastMode: false, createdAt: 1, updatedAt: 1 });
}

function commandHarness(store: OperationalStore, pending: SimulatorPendingCreateRegistry,
  devices = new Map<string, SimulatorDevice>()): {
  readonly create: SimulatorCreateRuntime;
  readonly lifecycle: SimulatorLifecycleRuntime;
  readonly commands: readonly string[][];
  readonly devices: Map<string, SimulatorDevice>;
} {
  const commands: string[][] = [];
  const ok = (stdout = ""): SimulatorCommandResult => ({ stdout, stderr: "", exitCode: 0 });
  const runner: SimulatorCommandRunner = { run: async (command, args) => {
    expect(command).toBe("/usr/bin/xcrun");
    commands.push([...args]);
    if (args[0] !== "simctl") throw new Error("Unexpected Simulator command.");
    if (args[1] === "list") return ok(JSON.stringify({
      runtimes: [{ identifier: RUNTIME, name: "iOS 19.0", isAvailable: true }],
      devices: { [RUNTIME]: [...devices.values()] }
    }));
    if (args[1] === "create") {
      expect(store.listOperations({ status: "started", sessionId: "first" }).length
        + store.listOperations({ status: "started", sessionId: "second" }).length).toBe(1);
      expect(pending.list()).toMatchObject([{ markerName: args[2], udid: null }]);
      devices.set(UDID, { ...DEVICE, udid: UDID, name: args[2]! });
      return ok(UDID);
    }
    if (args[1] === "rename") {
      const existing = devices.get(args[2]!);
      if (!existing) throw new Error("Unexpected Simulator rename.");
      devices.set(args[2]!, { ...existing, name: args[3]! });
      return ok();
    }
    if (args[1] === "delete") {
      devices.delete(args[2]!);
      return ok();
    }
    throw new Error("Unexpected Simulator command.");
  } };
  return {
    create: createSimulatorCreateRuntime({ platform: "darwin", runner }),
    lifecycle: { findExact: async udid => udid === TEMPLATE_UDID ? DEVICE : devices.get(udid) ?? null,
      bootExact: async () => { throw new Error("Unexpected boot."); },
      shutdownExact: async () => { throw new Error("Unexpected shutdown."); } },
    commands, devices
  };
}

it("durably arms before exact create, adopts before rename, and replays without another command", async () => {
  const store = new OperationalStore(":memory:");
  try {
    seed(store);
    const ownership = new SimulatorOwnershipRegistry(store);
    const pending = new SimulatorPendingCreateRegistry(store);
    const harness = commandHarness(store, pending);
    const coordinator = new SimulatorCreateCoordinator(store, ownership, pending, harness);
    const result = await coordinator.create(SCOPE, input, authority("a"));
    expect(result).toMatchObject({ replayed: false, instance: { sessionId: "first", simulatorUdid: UDID,
      simulatorName: input.name, creationProvenance: "joko", lifecycleState: "stopped" } });
    expect(harness.commands.map(args => args[1])).toEqual(["create", "list", "list", "rename", "list"]);
    expect(pending.list()).toEqual([]);
    expect(store.findOperation(`ios-simulator-create:${"a".repeat(64)}`)).toMatchObject({ status: "completed" });
    expect(await coordinator.create(SCOPE, input, authority("a"))).toEqual({ ...result, replayed: true });
    expect(harness.commands).toHaveLength(5);
    await expect(coordinator.create(SCOPE, input, authority("b"))).rejects.toMatchObject({ code: "SESSION_INSTANCE_LIMIT_REACHED" });
    expect(harness.commands).toHaveLength(5);
  } finally { store.close(); }
});

it("reopens SQLite and deletes only the orphaned Store marker after a crash before adoption", async () => {
  const directory = await mkdtemp(join(tmpdir(), "joko-simulator-create-"));
  const database = join(directory, "store.db");
  let store: OperationalStore | undefined;
  try {
    store = new OperationalStore(database);
    seed(store);
    const pending = new SimulatorPendingCreateRegistry(store);
    const devices = new Map<string, SimulatorDevice>();
    let entered!: () => void;
    const creating = new Promise<void>(resolve => { entered = resolve; });
    const interrupted: SimulatorCreateRuntime = {
      createExact: async (selected, evidence) => {
        evidence.arm(selected.markerName);
        devices.set(UDID, { ...DEVICE, udid: UDID, name: selected.markerName });
        entered();
        return new Promise(() => undefined);
      },
      findPendingMarker: async () => [], renameExact: async () => undefined, deletePendingExact: async () => undefined
    };
    const first = commandHarness(store, pending, devices);
    void new SimulatorCreateCoordinator(store, new SimulatorOwnershipRegistry(store), pending,
      { create: interrupted, lifecycle: first.lifecycle }).create(SCOPE, input, authority("d"));
    await creating;
    expect(pending.list()).toMatchObject([{ sessionId: "first", udid: null }]);
    store.close();
    store = new OperationalStore(database);
    expect(store.recoverStartup("simulator-create-recovery").recoveredEffectOperationIds).toHaveLength(1);
    const restoredPending = new SimulatorPendingCreateRegistry(store);
    const harness = commandHarness(store, restoredPending, devices);
    const coordinator = new SimulatorCreateCoordinator(store, new SimulatorOwnershipRegistry(store), restoredPending, harness);
    const outcome = await coordinator.recoverPending();
    expect(outcome).toMatchObject([{ result: "orphan_deleted" }]);
    expect(harness.commands.map(args => args[1])).toEqual(["list", "list", "delete", "list"]);
    expect(restoredPending.list()).toEqual([]);
    expect(devices.size).toBe(0);
    await expect(coordinator.create(SCOPE, input, authority("d"))).rejects.toThrow(/previously failed/u);
    expect(await coordinator.create(SCOPE, input, authority("e"))).toMatchObject({ replayed: false });
  } finally {
    store?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it("reopens SQLite and renames an adopted device without deleting it or replaying create", async () => {
  const directory = await mkdtemp(join(tmpdir(), "joko-simulator-adopt-"));
  const database = join(directory, "store.db");
  let store: OperationalStore | undefined;
  try {
    store = new OperationalStore(database);
    seed(store);
    const ownership = new SimulatorOwnershipRegistry(store);
    const pending = new SimulatorPendingCreateRegistry(store);
    const devices = new Map<string, SimulatorDevice>();
    const harness = commandHarness(store, pending, devices);
    let entered!: () => void;
    const renaming = new Promise<void>(resolve => { entered = resolve; });
    const interrupted: SimulatorCreateRuntime = { ...harness.create,
      renameExact: async () => { entered(); return new Promise(() => undefined); }
    };
    void new SimulatorCreateCoordinator(store, ownership, pending,
      { create: interrupted, lifecycle: harness.lifecycle }).create(SCOPE, input, authority("f"));
    await renaming;
    expect(pending.list()).toMatchObject([{ udid: UDID }]);
    expect(ownership.listForTask(SCOPE)).toMatchObject([{ simulatorUdid: UDID, simulatorName: input.name }]);
    store.close();
    store = new OperationalStore(database);
    expect(store.recoverStartup("simulator-adopt-recovery").recoveredEffectOperationIds).toHaveLength(1);
    const restoredPending = new SimulatorPendingCreateRegistry(store);
    const restored = new SimulatorOwnershipRegistry(store);
    const recoveryHarness = commandHarness(store, restoredPending, devices);
    const coordinator = new SimulatorCreateCoordinator(store, restored, restoredPending, recoveryHarness);
    expect(await coordinator.recoverPending()).toMatchObject([{ result: "owned_renamed" }]);
    expect(recoveryHarness.commands.map(args => args[1])).toEqual(["list", "rename", "list"]);
    expect(devices.get(UDID)?.name).toBe(input.name);
    expect(restoredPending.list()).toEqual([]);
    expect(restored.listForTask(SCOPE)).toMatchObject([{ healthState: "healthy", simulatorUdid: UDID }]);
    await expect(coordinator.create(SCOPE, input, authority("f"))).rejects.toThrow(/previously failed/u);
  } finally {
    store?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it("keeps uncertain evidence on identity drift, fences same-task concurrency, and never scans without evidence", async () => {
  const store = new OperationalStore(":memory:");
  try {
    seed(store);
    const ownership = new SimulatorOwnershipRegistry(store);
    const pending = new SimulatorPendingCreateRegistry(store);
    const devices = new Map<string, SimulatorDevice>();
    const harness = commandHarness(store, pending, devices);
    const coordinator = new SimulatorCreateCoordinator(store, ownership, pending, harness);
    expect(await coordinator.recoverPending()).toEqual([]);
    expect(harness.commands).toEqual([]);
    const invalid = { ...harness.lifecycle, findExact: async () => ({ ...DEVICE, runtimeIdentifier: "other-runtime" }) };
    await expect(new SimulatorCreateCoordinator(store, ownership, pending,
      { ...harness, lifecycle: invalid }).create(SCOPE, input, authority("1")))
      .rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(pending.list()).toEqual([]);
    let entered!: () => void;
    const creating = new Promise<void>(resolve => { entered = resolve; });
    let calls = 0;
    const hanging: SimulatorCreateRuntime = { ...harness.create,
      createExact: async (selected, evidence) => {
        evidence.arm(selected.markerName);
        calls += 1;
        if (calls === 1) entered();
        return new Promise(() => undefined);
      }
    };
    const active = new SimulatorCreateCoordinator(store, ownership, pending,
      { create: hanging, lifecycle: harness.lifecycle });
    void active.create(SCOPE, input, authority("2"));
    await creating;
    await expect(active.create(SCOPE, input, authority("3"))).rejects.toThrow(/in progress/u);
    void active.create(OTHER, input, authority("4"));
    await Promise.resolve();
    expect(pending.list()).toHaveLength(2);
    expect(calls).toBe(2);
  } finally { store.close(); }

  const failed = new OperationalStore(":memory:");
  try {
    seed(failed);
    const ownership = new SimulatorOwnershipRegistry(failed);
    const pending = new SimulatorPendingCreateRegistry(failed);
    const devices = new Map<string, SimulatorDevice>();
    const harness = commandHarness(failed, pending, devices);
    const uncertain: SimulatorCreateRuntime = { ...harness.create,
      createExact: async (selected, evidence) => {
        evidence.arm(selected.markerName);
        devices.set(UDID, { ...DEVICE, udid: UDID, name: selected.markerName, deviceTypeIdentifier: "other-type" });
        throw new SimulatorCreateError("SIMULATOR_CREATE_UNKNOWN", "Simulator create outcome is unknown.");
      }
    };
    const coordinator = new SimulatorCreateCoordinator(failed, ownership, pending,
      { create: uncertain, lifecycle: harness.lifecycle });
    await expect(coordinator.create(SCOPE, input, authority("5"))).rejects.toMatchObject({ code: "SIMULATOR_CREATE_UNKNOWN" });
    expect(failed.findOperation(`ios-simulator-create:${"5".repeat(64)}`)).toMatchObject({ status: "failed" });
    expect(await coordinator.recoverPending()).toMatchObject([{ result: "retained" }]);
    expect(pending.list()).toHaveLength(1);
    expect(harness.commands.map(args => args[1])).toEqual(["list"]);
    await expect(coordinator.create(SCOPE, input, authority("6"))).rejects.toThrow(/in progress/u);
  } finally { failed.close(); }
});

it("retains pending evidence when its exact device is owned by another task", async () => {
  for (const knownUdid of [false, true]) {
    const store = new OperationalStore(":memory:");
    try {
      seed(store);
      const ownership = new SimulatorOwnershipRegistry(store);
      const pending = new SimulatorPendingCreateRegistry(store);
      const markerName = pending.newMarker();
      pending.evidence({ markerName, sessionId: SCOPE.sessionId, targetId: SCOPE.targetId,
        bindingGeneration: SCOPE.generation, operationId: `ios-simulator-create:${"a".repeat(64)}`,
        name: input.name, runtimeIdentifier: RUNTIME, deviceTypeIdentifier: TYPE }).arm(markerName);
      if (knownUdid) pending.markCreated(markerName, UDID);
      const marked = { ...DEVICE, udid: UDID, name: markerName };
      ownership.bindExternalDevice(OTHER, marked);
      const harness = commandHarness(store, pending, new Map([[UDID, marked]]));
      const coordinator = new SimulatorCreateCoordinator(store, ownership, pending, harness);
      expect(await coordinator.recoverPending()).toEqual([{ markerName, result: "retained" }]);
      expect(pending.list()).toHaveLength(1);
      expect(harness.devices.get(UDID)?.name).toBe(markerName);
      expect(harness.commands.some(args => args[1] === "delete")).toBe(false);
    } finally { store.close(); }
  }
});

it("does not complete a renamed create after cancellation or a workspace owner change", async () => {
  for (const failure of ["cancel", "workspace"] as const) {
    const store = new OperationalStore(":memory:");
    try {
      seed(store);
      const ownership = new SimulatorOwnershipRegistry(store);
      const pending = new SimulatorPendingCreateRegistry(store);
      const harness = commandHarness(store, pending);
      const controller = new AbortController();
      const changing: SimulatorCreateRuntime = { ...harness.create,
        renameExact: async (selected, signal) => {
          await harness.create.renameExact(selected, signal);
          if (failure === "cancel") controller.abort();
          else store.upsertTarget({ ...store.getTarget("target").descriptor, workspaceRoot: "D:/different" });
        }
      };
      const coordinator = new SimulatorCreateCoordinator(store, ownership, pending,
        { create: changing, lifecycle: harness.lifecycle });
      await expect(coordinator.create(SCOPE, input, authority(failure === "cancel" ? "7" : "8"), controller.signal))
        .rejects.toBeInstanceOf(Error);
      expect(store.listOperations({ sessionId: "first" }).find(item => item.kind === "ios_simulator_create"))
        .toMatchObject({ status: "failed" });
      expect(pending.list()).toMatchObject([{ udid: UDID }]);
      expect(harness.devices.get(UDID)?.name).toBe(input.name);
      if (failure === "cancel") {
        expect(ownership.listForTask(SCOPE)).toMatchObject([{ healthState: "degraded", lifecycleState: "error" }]);
        expect(await new SimulatorCreateCoordinator(store, ownership, pending, harness).recoverPending())
          .toMatchObject([{ result: "owned_renamed" }]);
        expect(ownership.listForTask(SCOPE)).toMatchObject([{ healthState: "healthy" }]);
      } else {
        expect(() => ownership.listForTask(SCOPE)).toThrow(/no longer matches/u);
      }
    } finally { store.close(); }
  }
});
