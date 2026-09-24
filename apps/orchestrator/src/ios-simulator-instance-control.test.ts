import { OperationalStore } from "@joko/store";
import { SimulatorResourceScheduler, WDA_SOURCE_PIN,
  type SimulatorCreateRuntime, type SimulatorDevice, type SimulatorLifecycleRuntime,
  type WdaRunningDriver } from "@joko/tool-ios-simulator";
import { expect, it } from "vitest";
import { SimulatorCreateCoordinator } from "./ios-simulator-create-coordinator.js";
import { SimulatorDriverCoordinator } from "./ios-simulator-driver-coordinator.js";
import { SimulatorInstanceControlCoordinator } from "./ios-simulator-instance-control.js";
import { SimulatorLifecycleCoordinator, type SimulatorLifecycleEffectAuthority } from "./ios-simulator-lifecycle-coordinator.js";
import { SimulatorOwnershipRegistry, type PublicSimulatorInstance } from "./ios-simulator-ownership.js";
import { SimulatorPendingCreateRegistry } from "./ios-simulator-pending-create.js";

const SCOPE = { sessionId: "first", targetId: "target", generation: 1 } as const;
const TEMPLATE = "A0123456-1234-1234-1234-123456789ABC";
const CREATED = "B0123456-1234-1234-1234-123456789ABC";
const LEASE = "C0123456-1234-1234-1234-123456789ABC";
const RUNTIME = "com.apple.CoreSimulator.SimRuntime.iOS-19-0";
const TYPE = "com.apple.CoreSimulator.SimDeviceType.iPhone-17";
const template: SimulatorDevice = { udid: TEMPLATE, name: "Template", state: "Shutdown", isAvailable: true,
  runtimeIdentifier: RUNTIME, runtimeName: "iOS 19.0", runtimeVersion: "19.0",
  deviceTypeIdentifier: TYPE, lastBootedAt: null };

function authority(char: string): SimulatorLifecycleEffectAuthority {
  return { effectIdentity: char.repeat(64), requestBodyHash: `sha256:${char.repeat(64)}`, providerGeneration: 1 };
}

function route(instance: PublicSimulatorInstance) {
  return { instanceId: instance.instanceId, generation: instance.generation, leaseId: instance.lease.id };
}

function seed(store: OperationalStore): void {
  store.upsertBackend({ id: "pi", displayName: "Pi", version: "fixture", health: "healthy",
    adapterKind: "fixture", instanceGeneration: 0, installationState: "installed",
    authenticationState: "not_required", capabilities: new Map(), models: [], tools: [], diagnostics: [] });
  store.upsertTarget({ id: "target", backendId: "pi", displayName: "Local workspace",
    workspaceRoot: "D:/workspace", managed: false, trusted: true });
  store.createSession({ id: "first", backendId: "pi", targetId: "target", title: "first",
    binding: { opaqueRef: "first", generation: 1 }, pinned: false, archived: false,
    permissionMode: "ask", planMode: false, fastMode: false, createdAt: 1, updatedAt: 1 });
}

function harness(store: OperationalStore, options: { readonly now?: () => number;
  readonly detachGraceMs?: number; readonly onShutdown?: () => Promise<void> } = {}) {
  seed(store);
  const events: string[] = [];
  const devices = new Map<string, SimulatorDevice>([[TEMPLATE, template]]);
  const ownership = new SimulatorOwnershipRegistry(store, { now: options.now });
  const pending = new SimulatorPendingCreateRegistry(store);
  const lifecycleRuntime: SimulatorLifecycleRuntime = {
    findExact: async udid => devices.get(udid.toUpperCase()) ?? null,
    bootExact: async udid => { events.push("boot"); const before = devices.get(udid)!;
      const booted = { ...before, state: "Booted" }; devices.set(udid, booted); return booted; },
    shutdownExact: async udid => { events.push("shutdown"); await options.onShutdown?.();
      const before = devices.get(udid)!;
      devices.set(udid, { ...before, state: "Shutdown" }); }
  };
  const createRuntime: SimulatorCreateRuntime = {
    createExact: async (input, evidence) => {
      evidence.arm(input.markerName);
      expect(store.listOperations({ sessionId: SCOPE.sessionId, status: "started" })
        .some(operation => operation.kind === "ios_simulator_instance_control")).toBe(true);
      events.push("create");
      devices.set(CREATED, { ...template, udid: CREATED, name: input.markerName });
      return { ...input, udid: CREATED };
    },
    findPendingMarker: async marker => [...devices.values()].filter(item => item.name === marker),
    renameExact: async input => { events.push("rename"); const before = devices.get(input.udid)!;
      devices.set(input.udid, { ...before, name: input.name }); },
    deletePendingExact: async input => { devices.delete(input.udid); events.push("delete-pending"); }
  };
  let active: WdaRunningDriver | null = null;
  const driver = new SimulatorDriverCoordinator(store, ownership, {
    archivePath: "/private/joko/wda.tar.gz", cacheRoot: "/private/joko/driver-cache", architecture: "arm64",
    environment: { inspect: async () => ({ platform: "darwin", supported: true, ready: true,
      xcodeVersion: "Xcode 16.4\nBuild version 16F6", runtimes: [], devices: [...devices.values()],
      issue: null, error: null, setupSteps: [] }) },
    lifecycle: lifecycleRuntime,
    cleanupOrphans: async () => { events.push("orphan-cleanup"); },
    manager: {
      get: () => active,
      retryOwnedCleanup: async () => { events.push("retry-cleanup"); },
      start: async options => { events.push("driver-start");
        active = { instanceId: options.instanceId, simulatorUdid: options.simulatorUdid,
          leaseId: LEASE, pid: 301, controlPort: 18100, mjpegPort: 19100,
          sourceRevision: WDA_SOURCE_PIN.revision, buildCacheKey: "a".repeat(64),
          driverSessionId: "SESSION-1", health: { ready: true, message: null, osName: "iOS",
            osVersion: "19.0", sdkVersion: "19.0", deviceIp: null }, state: "ready" };
        return active; },
      stop: async () => { events.push("driver-stop"); active = null; }
    }
  });
  const lifecycle = new SimulatorLifecycleCoordinator(store, ownership, lifecycleRuntime,
    new SimulatorResourceScheduler({ memoryProbe: async () => ({ source: "node-os", freePercentage: 50,
      freeBytes: 4 * 1024 ** 3, totalBytes: 8 * 1024 ** 3 }) }));
  const create = new SimulatorCreateCoordinator(store, ownership, pending,
    { create: createRuntime, lifecycle: lifecycleRuntime });
  return { control: new SimulatorInstanceControlCoordinator(store, ownership,
    { create, lifecycle, driver, devices: lifecycleRuntime, now: options.now,
      detachGraceMs: options.detachGraceMs }), ownership, driver, events, devices };
}

it("composes durable create, boot, driver, Viewer and stop effects with exact replay", async () => {
  const store = new OperationalStore(":memory:");
  try {
    const h = harness(store);
    const created = await h.control.create(SCOPE, { templateUdid: TEMPLATE, name: "Joko iPhone" }, authority("a"));
    expect(created).toMatchObject({ replayed: false, instance: { creationProvenance: "joko",
      lifecycleState: "stopped", viewerState: "attached", generation: 2 } });
    expect(h.events).toEqual(["create", "rename"]);
    expect(await h.control.create(SCOPE, { templateUdid: TEMPLATE, name: "Joko iPhone" }, authority("a")))
      .toMatchObject({ replayed: true, instance: { generation: created.instance.generation } });
    const started = await h.control.start(SCOPE, route(created.instance), authority("b"));
    expect(started.instance).toMatchObject({ lifecycleState: "ready", viewerState: "attached",
      bootProvenance: "agent_booted" });
    expect(h.driver.isReady(started.instance)).toBe(true);
    expect(h.events).toEqual(["create", "rename", "boot", "retry-cleanup", "orphan-cleanup", "driver-start"]);
    const renewed = await h.control.start(SCOPE, route(started.instance), authority("c"));
    expect(h.driver.isReady(renewed.instance)).toBe(true);
    expect(h.events.filter(event => event === "driver-start")).toHaveLength(1);
    const stopped = await h.control.stop(SCOPE, route(renewed.instance), authority("d"));
    expect(stopped.instance).toMatchObject({ lifecycleState: "stopped", viewerState: "detached" });
    expect(h.events.slice(-4)).toEqual(["driver-stop", "retry-cleanup", "orphan-cleanup", "shutdown"]);
    await expect(h.control.start(SCOPE, route(created.instance), authority("e")))
      .rejects.toMatchObject({ code: "STALE_SCOPE" });
    h.control.dispose();
  } finally { store.close(); }
});

it("attaches an exact preexisting booted device and retains its driver on a ready start", async () => {
  const store = new OperationalStore(":memory:");
  try {
    const h = harness(store);
    h.devices.set(TEMPLATE, { ...template, state: "Booted" });
    const attached = await h.control.attach(SCOPE, TEMPLATE, authority("f"));
    expect(attached.instance).toMatchObject({ creationProvenance: "external", bootProvenance: "preexisting",
      lifecycleState: "ready", viewerState: "attached" });
    expect(h.driver.isReady(attached.instance)).toBe(true);
    const started = await h.control.start(SCOPE, route(attached.instance), authority("1"));
    expect(h.driver.isReady(started.instance)).toBe(true);
    expect(h.events.filter(event => event === "driver-start")).toHaveLength(1);
    expect(h.events).not.toContain("boot");
    h.control.dispose();
  } finally { store.close(); }
});

it("retains an agent-booted detached device for grace, cancels cleanup on reattach, then releases it after exact shutdown", async () => {
  const store = new OperationalStore(":memory:");
  let now = 1_000;
  const h = harness(store, { now: () => now, detachGraceMs: 10_000 });
  try {
    const bound = h.ownership.bindExternalDevice(SCOPE, template);
    const started = await h.control.start(SCOPE, route(bound), authority("2"));
    const detached = await h.control.detach(SCOPE, route(started.instance), authority("3"));
    expect(detached.instance).toMatchObject({ viewerState: "detached", bootProvenance: "agent_booted",
      graceExpiresAt: 11_000 });
    expect(h.ownership.listForTask(SCOPE)).toHaveLength(1);
    expect(h.events).not.toContain("shutdown");
    now = 5_000;
    const reattached = await h.control.attach(SCOPE, TEMPLATE, authority("4"));
    expect(reattached.instance).toMatchObject({ viewerState: "attached", graceExpiresAt: null });
    expect(h.driver.isReady(reattached.instance)).toBe(true);
    now = 12_000;
    await h.control.reconcileDetachedGrace();
    expect(h.events).not.toContain("shutdown");
    const again = await h.control.detach(SCOPE, route(reattached.instance), authority("5"));
    expect(again.instance.graceExpiresAt).toBe(22_000);
    now = 23_000;
    await h.control.reconcileDetachedGrace();
    expect(h.events.filter(event => event === "shutdown")).toHaveLength(1);
    expect(h.ownership.listForTask(SCOPE)).toEqual([]);
    expect(store.listOperations({ sessionId: SCOPE.sessionId })
      .some(operation => operation.kind === "ios_simulator_grace_cleanup" && operation.status === "completed")).toBe(true);
  } finally { h.control.dispose(); store.close(); }
});

it("detaches a preexisting device without shutting it down or retaining ownership", async () => {
  const store = new OperationalStore(":memory:");
  const h = harness(store);
  try {
    h.devices.set(TEMPLATE, { ...template, state: "Booted" });
    const attached = await h.control.attach(SCOPE, TEMPLATE, authority("6"));
    const detached = await h.control.detach(SCOPE, route(attached.instance), authority("7"));
    expect(detached.instance).toMatchObject({ viewerState: "detached", graceExpiresAt: null });
    expect(h.ownership.listForTask(SCOPE)).toEqual([]);
    expect(h.devices.get(TEMPLATE)?.state).toBe("Booted");
    expect(h.events).not.toContain("shutdown");
    expect(await h.control.detach(SCOPE, route(attached.instance), authority("7")))
      .toMatchObject({ replayed: true });
  } finally { h.control.dispose(); store.close(); }
});

it("holds the durable grace cleanup claim while exact shutdown is pending, so reattach cannot race it", async () => {
  const store = new OperationalStore(":memory:");
  let now = 1_000;
  let entered!: () => void;
  let release!: () => void;
  const shutdownEntered = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const h = harness(store, { now: () => now, detachGraceMs: 10_000,
    onShutdown: async () => { entered(); await gate; } });
  try {
    const bound = h.ownership.bindExternalDevice(SCOPE, template);
    const started = await h.control.start(SCOPE, route(bound), authority("8"));
    await h.control.detach(SCOPE, route(started.instance), authority("9"));
    now = 12_000;
    const pending = h.control.reconcileDetachedGrace();
    await shutdownEntered;
    await h.control.reconcileDetachedGrace();
    await expect(h.control.attach(SCOPE, TEMPLATE, authority("a"))).rejects.toThrow(/in progress/u);
    expect(h.events.filter(event => event === "driver-start")).toHaveLength(1);
    release();
    await pending;
    expect(h.events.filter(event => event === "shutdown")).toHaveLength(1);
    expect(h.ownership.listForTask(SCOPE)).toEqual([]);
  } finally { release(); h.control.dispose(); store.close(); }
});

it("keeps a failed grace cleanup binding for an exact retry", async () => {
  const store = new OperationalStore(":memory:");
  let now = 1_000;
  let fail = true;
  const h = harness(store, { now: () => now, detachGraceMs: 10_000,
    onShutdown: async () => { if (fail) { fail = false; throw new Error("private host failure"); } } });
  try {
    const bound = h.ownership.bindExternalDevice(SCOPE, template);
    const started = await h.control.start(SCOPE, route(bound), authority("b"));
    await h.control.detach(SCOPE, route(started.instance), authority("c"));
    now = 12_000;
    await h.control.reconcileDetachedGrace();
    expect(h.ownership.listForTask(SCOPE)).toHaveLength(1);
    const failed = store.listOperations({ sessionId: SCOPE.sessionId, status: "failed" })
      .find(operation => operation.kind === "ios_simulator_grace_cleanup");
    expect(failed?.error).toMatchObject({ code: "EFFECT_FAILED",
      message: "Simulator grace cleanup outcome is unknown." });
    expect(JSON.stringify(failed?.error)).not.toContain("private host failure");
    await h.control.reconcileDetachedGrace();
    expect(h.ownership.listForTask(SCOPE)).toEqual([]);
  } finally { h.control.dispose(); store.close(); }
});

it("retires the exact driver and agent-booted device after its task is archived", async () => {
  const store = new OperationalStore(":memory:");
  const h = harness(store);
  try {
    const bound = h.ownership.bindExternalDevice(SCOPE, template);
    const started = await h.control.start(SCOPE, route(bound), authority("d"));
    await h.control.reconcileAbandoned();
    expect(h.driver.isReady(started.instance)).toBe(true);
    store.updateSession(SCOPE.sessionId, { archived: true });
    await h.control.reconcileAbandoned();
    expect(h.events.slice(-4)).toEqual(["driver-stop", "retry-cleanup", "orphan-cleanup", "shutdown"]);
    expect(h.devices.get(TEMPLATE)?.state).toBe("Shutdown");
    expect(h.ownership.listForRecovery()).toEqual([]);
    expect(store.listOperations({ sessionId: SCOPE.sessionId })
      .some(operation => operation.kind === "ios_simulator_removed_cleanup" &&
        operation.status === "completed")).toBe(true);
  } finally { h.control.dispose(); store.close(); }
});

it("releases an archived task's preexisting device without shutting it down", async () => {
  const store = new OperationalStore(":memory:");
  const h = harness(store);
  try {
    h.devices.set(TEMPLATE, { ...template, state: "Booted" });
    await h.control.attach(SCOPE, TEMPLATE, authority("e"));
    store.updateSession(SCOPE.sessionId, { archived: true });
    await h.control.reconcileAbandoned();
    expect(h.events).toContain("driver-stop");
    expect(h.events).not.toContain("shutdown");
    expect(h.devices.get(TEMPLATE)?.state).toBe("Booted");
    expect(h.ownership.listForRecovery()).toEqual([]);
  } finally { h.control.dispose(); store.close(); }
});

it("quarantines a lost task while cleanup fails and retries only its exact device", async () => {
  const store = new OperationalStore(":memory:");
  let fail = true;
  const h = harness(store, { onShutdown: async () => {
    if (fail) { fail = false; throw new Error("private host failure"); }
  } });
  try {
    const bound = h.ownership.bindExternalDevice(SCOPE, template);
    await h.control.start(SCOPE, route(bound), authority("f"));
    store.updateSession(SCOPE.sessionId, { archived: true });
    await h.control.reconcileAbandoned();
    expect(h.ownership.listForRecovery()).toMatchObject([{ viewerState: "detached",
      healthState: "degraded", errorCode: "TASK_UNAVAILABLE" }]);
    expect(h.events.filter(event => event === "shutdown")).toHaveLength(1);
    const failed = store.listOperations({ sessionId: SCOPE.sessionId, status: "failed" })
      .find(operation => operation.kind === "ios_simulator_removed_cleanup");
    expect(JSON.stringify(failed?.error)).not.toContain("private host failure");
    await h.control.reconcileAbandoned();
    expect(h.events.filter(event => event === "shutdown")).toHaveLength(2);
    expect(h.ownership.listForRecovery()).toEqual([]);
  } finally { h.control.dispose(); store.close(); }
});
