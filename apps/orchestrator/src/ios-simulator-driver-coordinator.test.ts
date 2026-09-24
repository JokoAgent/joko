import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OperationalStore } from "@joko/store";
import { createWdaOwnerFingerprint, WDA_SOURCE_PIN, type WdaRunningDriver } from "@joko/tool-ios-simulator";
import { expect, it } from "vitest";
import { SimulatorDriverCoordinator, type SimulatorDriverCoordinatorOptions } from "./ios-simulator-driver-coordinator.js";
import { SimulatorDriverStateRegistry } from "./ios-simulator-driver-state.js";
import { SimulatorLifecycleCoordinator } from "./ios-simulator-lifecycle-coordinator.js";
import { SimulatorOwnershipRegistry, type SimulatorInstanceRoute } from "./ios-simulator-ownership.js";

const UDID = "A0123456-1234-1234-1234-123456789ABC";
const LEASE = "B0123456-1234-1234-1234-123456789ABC";
const SCOPE = { sessionId: "first", targetId: "target", generation: 1 };
const DEVICE = { udid: UDID, name: "iPhone test", state: "Booted", isAvailable: true,
  runtimeIdentifier: "com.apple.CoreSimulator.SimRuntime.iOS-19-0", runtimeName: "iOS 19.0",
  runtimeVersion: "19.0", deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-17",
  lastBootedAt: null } as const;
const ENVIRONMENT = { platform: "darwin" as const, supported: true, ready: true,
  xcodeVersion: "Xcode 16.4\nBuild version 16F6", runtimes: [], devices: [DEVICE],
  issue: null, error: null, setupSteps: [] };

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

function authority(char: string) {
  return { effectIdentity: char.repeat(64), requestBodyHash: `sha256:${char.repeat(64)}`, providerGeneration: 1 };
}

function route(instance: { instanceId: string; generation: number; lease: { id: string } }): SimulatorInstanceRoute {
  return { instanceId: instance.instanceId, generation: instance.generation, leaseId: instance.lease.id };
}

function running(instanceId: string, controlPort = 18100): WdaRunningDriver {
  return { instanceId, simulatorUdid: UDID, leaseId: LEASE, pid: 301, controlPort,
    mjpegPort: 19100, sourceRevision: WDA_SOURCE_PIN.revision, buildCacheKey: "a".repeat(64),
    driverSessionId: "SESSION-1", health: { ready: true, message: null, osName: "iOS",
      osVersion: "19.0", sdkVersion: "19.0", deviceIp: null }, state: "ready" };
}

function harness(store: OperationalStore, ownership: SimulatorOwnershipRegistry,
  input: { readonly onStart?: () => Promise<void>; readonly onInspect?: () => void;
    readonly environmentReady?: boolean; readonly controlPort?: number } = {}) {
  let active: WdaRunningDriver | null = null;
  const effects: string[] = [];
  const options: SimulatorDriverCoordinatorOptions = { archivePath: "/private/joko/wda.tar.gz",
    cacheRoot: "/private/joko/driver-cache", architecture: "arm64",
    environment: { inspect: async () => { input.onInspect?.();
      return { ...ENVIRONMENT, ready: input.environmentReady ?? true }; } },
    lifecycle: { findExact: async () => DEVICE, bootExact: async () => DEVICE,
      shutdownExact: async () => undefined },
    cleanupOrphans: async () => { expect(store.listOperations({ sessionId: SCOPE.sessionId,
      status: "started" }).some(operation => operation.kind === "ios_simulator_driver")).toBe(true);
      effects.push("orphan"); },
    manager: { get: () => active,
      retryOwnedCleanup: async () => { effects.push("retry"); },
      start: async options => { effects.push("start");
        expect(store.findOperation(`ios-simulator-driver:${"a".repeat(64)}`)?.status).toBe("started");
        await input.onStart?.(); active = running(options.instanceId, input.controlPort); return active; },
      stop: async () => { effects.push("stop"); active = null; } } };
  return { coordinator: new SimulatorDriverCoordinator(store, ownership, options), effects,
    get active() { return active; }, loseActive: () => { active = null; } };
}

it("claims before cleanup and launch, commits ready with a new route, then stops and prevents stale replay", async () => {
  const store = new OperationalStore(":memory:");
  try {
    seed(store);
    const ownership = new SimulatorOwnershipRegistry(store);
    const initial = ownership.bindExternalDevice(SCOPE, DEVICE);
    const h = harness(store, ownership);
    const started = await h.coordinator.start(SCOPE, route(initial), authority("a"));
    expect(started).toMatchObject({ state: "ready", replayed: false,
      instance: { generation: initial.generation + 1, viewerState: "detached" } });
    expect(h.effects).toEqual(["retry", "orphan", "start"]);
    expect(new SimulatorDriverStateRegistry(store).get(initial.instanceId)).toMatchObject({
      state: "ready", managerLeaseId: LEASE, instanceGeneration: started.instance.generation });
    expect(await h.coordinator.start(SCOPE, route(initial), authority("a"))).toMatchObject({ replayed: true });
    expect(h.effects).toEqual(["retry", "orphan", "start"]);
    await expect(h.coordinator.start(SCOPE, route(started.instance), authority("b")))
      .rejects.toMatchObject({ code: "DRIVER_BUSY" });
    expect(ownership.listForTask(SCOPE)[0]?.generation).toBe(started.instance.generation);
    expect(h.active?.state).toBe("ready");
    const stopped = await h.coordinator.stop(SCOPE, route(started.instance), authority("c"));
    expect(stopped).toMatchObject({ state: "stopped", replayed: false });
    expect(h.effects).toEqual(["retry", "orphan", "start", "stop", "retry", "orphan"]);
    expect(new SimulatorDriverStateRegistry(store).get(initial.instanceId)).toBeNull();
    await expect(h.coordinator.start(SCOPE, route(initial), authority("a")))
      .rejects.toMatchObject({ code: "STALE_DRIVER" });
  } finally { store.close(); }
});

it("does not dispatch when the device or host is unavailable and serializes a started effect", async () => {
  const store = new OperationalStore(":memory:");
  try {
    seed(store);
    const ownership = new SimulatorOwnershipRegistry(store);
    const instance = ownership.bindExternalDevice(SCOPE, DEVICE);
    const unavailable = harness(store, ownership, { environmentReady: false });
    await expect(unavailable.coordinator.start(SCOPE, route(instance), authority("d")))
      .rejects.toMatchObject({ code: "DRIVER_UNAVAILABLE" });
    expect(unavailable.effects).toEqual([]);
    expect(ownership.listForTask(SCOPE)[0]?.generation).toBe(instance.generation);
    const controller = new AbortController();
    const cancelled = harness(store, ownership, { onInspect: () => controller.abort() });
    await expect(cancelled.coordinator.start(SCOPE, route(instance), authority("9"), controller.signal))
      .rejects.toMatchObject({ code: "MUTATION_CANCELLED" });
    expect(cancelled.effects).toEqual([]);
    expect(ownership.listForTask(SCOPE)[0]?.generation).toBe(instance.generation);
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const h = harness(store, ownership, { onStart: async () => { entered(); await gate; } });
    const pending = h.coordinator.start(SCOPE, route(instance), authority("a"));
    await started;
    await expect(h.coordinator.start(SCOPE, route(instance), authority("b")))
      .rejects.toThrow(/in progress/u);
    const lifecycle = new SimulatorLifecycleCoordinator(store, ownership, {
      findExact: async () => DEVICE, bootExact: async () => DEVICE, shutdownExact: async () => undefined });
    await expect(lifecycle.stop(SCOPE, route(instance), authority("c"))).rejects.toThrow(/in progress/u);
    expect(h.effects.filter(item => item === "start")).toHaveLength(1);
    release();
    const completed = await pending;
    const lifecycleClaim = store.claimDeferredEffectOperation({ id: `ios-simulator-lifecycle:${"f".repeat(64)}`,
      kind: "ios_simulator_lifecycle", body: { sessionId: SCOPE.sessionId } });
    await expect(h.coordinator.stop(SCOPE, route(completed.instance), authority("e")))
      .rejects.toThrow(/in progress/u);
    store.failEffectOperation(lifecycleClaim.operation.id, lifecycleClaim.operation.bodyHash,
      new Error("Controlled lifecycle interruption."));
  } finally { store.close(); }
});

it("routes input through the exact ready driver session and rechecks its lease", async () => {
  const requests: Array<{ url: string; body: unknown }> = [];
  let ownerFingerprint = "";
  let retireOnReply = false;
  let loseActive = (): void => undefined;
  let orientation: "PORTRAIT" | "LANDSCAPE" = "PORTRAIT";
  const server = createServer((request, response) => {
    const send = (value: unknown): void => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ value }));
    };
    if (request.method === "GET" && request.url === "/status") {
      send({ ready: true, build: { upgradedAt: ownerFingerprint } });
      return;
    }
    if (request.method === "GET" && request.url === "/session/SESSION-1/window/size") {
      send({ width: 393, height: 852 });
      return;
    }
    if (request.method === "GET" && request.url === "/session/SESSION-1/orientation") {
      send(orientation);
      return;
    }
    if (request.method !== "POST") { response.writeHead(404); response.end(); return; }
    const chunks: Buffer[] = [];
    request.on("data", chunk => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      requests.push({ url: request.url ?? "", body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
      if (request.url === "/session/SESSION-1/orientation") orientation = "LANDSCAPE";
      if (retireOnReply) { retireOnReply = false; loseActive(); }
      send(null);
    });
  });
  const store = new OperationalStore(":memory:");
  try {
    await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Loopback port was not allocated.");
    seed(store);
    const ownership = new SimulatorOwnershipRegistry(store);
    const initial = ownership.bindExternalDevice(SCOPE, DEVICE);
    const h = harness(store, ownership, { controlPort: address.port });
    loseActive = h.loseActive;
    const started = await h.coordinator.start(SCOPE, route(initial), authority("a"));
    ownerFingerprint = createWdaOwnerFingerprint({ cacheRoot: "/private/joko/driver-cache",
      instanceId: started.instance.instanceId, simulatorUdid: UDID });
    await h.coordinator.tap(started.instance, { x: 10, y: 20 });
    await h.coordinator.swipe(started.instance, { x: 1, y: 2 }, { x: 3, y: 4 }, 300);
    await h.coordinator.typeText(started.instance, "hello");
    await h.coordinator.pressHome(started.instance);
    await expect(h.coordinator.setOrientation(started.instance, "LANDSCAPE")).resolves.toEqual({
      width: 393, height: 852, orientation: "LANDSCAPE"
    });
    await h.coordinator.lockScreen(started.instance);
    await h.coordinator.unlockScreen(started.instance);
    expect(requests.map(item => item.url)).toEqual([
      "/session/SESSION-1/actions", "/session/SESSION-1/actions",
      "/session/SESSION-1/wda/keys", "/session/SESSION-1/wda/pressButton",
      "/session/SESSION-1/orientation", "/session/SESSION-1/wda/lock",
      "/session/SESSION-1/wda/unlock"
    ]);
    const tapBody = requests[0]?.body as { actions: Array<{ id: string;
      actions: Array<Record<string, unknown>> }> };
    expect(tapBody.actions[0]).toMatchObject({ id: "finger" });
    expect(tapBody.actions[0]?.actions[0]).toMatchObject({ type: "pointerMove", x: 10, y: 20 });
    expect(requests[2]?.body).toEqual({ value: ["h", "e", "l", "l", "o"] });
    expect(requests[3]?.body).toEqual({ name: "home" });
    expect(requests[4]?.body).toEqual({ orientation: "LANDSCAPE" });
    expect(requests[5]?.body).toEqual({});
    expect(requests[6]?.body).toEqual({});
    retireOnReply = true;
    await expect(h.coordinator.lockScreen(started.instance))
      .rejects.toMatchObject({ code: "INPUT_OUTCOME_UNKNOWN" });
  } finally {
    store.close();
    server.closeAllConnections();
    await new Promise<void>(done => server.close(() => done()));
  }
});

it("invalidates old process readiness after SQLite reopen and fences an unknown driver effect", async () => {
  const directory = await mkdtemp(join(tmpdir(), "joko-simulator-driver-"));
  const path = join(directory, "store.db");
  let store: OperationalStore | undefined;
  try {
    store = new OperationalStore(path);
    seed(store);
    const ownership = new SimulatorOwnershipRegistry(store);
    const instance = ownership.bindExternalDevice(SCOPE, DEVICE);
    const first = harness(store, ownership);
    const started = await first.coordinator.start(SCOPE, route(instance), authority("a"));
    store.close();
    store = new OperationalStore(path);
    const restored = new SimulatorOwnershipRegistry(store);
    const live = new SimulatorDriverStateRegistry(store);
    expect(live.get(instance.instanceId)).toMatchObject({ state: "ready", ownerPid: process.pid });
    const second = harness(store, restored);
    await expect(second.coordinator.start(SCOPE, route(started.instance), authority("b")))
      .rejects.toMatchObject({ code: "DRIVER_BUSY" });
    expect(second.effects).toEqual([]);
    const state = new SimulatorDriverStateRegistry(store, { ownerAlive: () => false });
    expect(state.get(instance.instanceId)).toMatchObject({ state: "error", errorCode: "DRIVER_RUNTIME_LOST" });
    await expect(second.coordinator.start(SCOPE, route(instance), authority("a")))
      .rejects.toMatchObject({ code: "DRIVER_RUNTIME_LOST" });
    expect(second.effects).toEqual([]);
    store.claimDeferredEffectOperation({ id: `ios-simulator-driver:${"e".repeat(64)}`,
      kind: "ios_simulator_driver", body: { action: "start", sessionId: SCOPE.sessionId,
        targetId: SCOPE.targetId, bindingGeneration: SCOPE.generation,
        instanceId: started.instance.instanceId, instanceGeneration: started.instance.generation,
        leaseId: started.instance.lease.id, requestBodyHash: authority("e").requestBodyHash,
        providerGeneration: 1 } });
    store.close();
    store = new OperationalStore(path);
    store.recoverStartup("simulator-driver-recovery");
    const afterCrash = new SimulatorOwnershipRegistry(store);
    expect(afterCrash.listForTask(SCOPE)[0]).toMatchObject({
      generation: started.instance.generation + 1, healthState: "degraded", errorCode: "EFFECT_OUTCOME_UNKNOWN" });
  } finally {
    store?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
