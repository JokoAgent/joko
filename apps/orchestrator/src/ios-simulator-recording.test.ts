import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OperationalStore } from "@joko/store";
import { SimulatorRecordingRuntimeError, type SimulatorRecordingRuntime } from "@joko/tool-ios-simulator";
import { expect, it } from "vitest";
import { SimulatorOwnershipRegistry, type PublicSimulatorInstance } from "./ios-simulator-ownership.js";
import { SimulatorRecordingCoordinator } from "./ios-simulator-recording.js";

const SCOPE = { sessionId: "recording-task", targetId: "local", generation: 1 } as const;
const UDID = "A0123456-1234-1234-1234-123456789ABC";
const DEVICE = { udid: UDID, name: "iPhone", state: "Booted", isAvailable: true,
  runtimeIdentifier: "com.apple.CoreSimulator.SimRuntime.iOS-19-0", runtimeName: "iOS 19.0",
  runtimeVersion: "19.0", deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-17",
  lastBootedAt: null } as const;
const MOV = Buffer.from([0, 0, 0, 16, 102, 116, 121, 112, 113, 116, 32, 32, 0, 0, 0, 0]);

function route(instance: PublicSimulatorInstance) {
  return { instanceId: instance.instanceId, generation: instance.generation, leaseId: instance.lease.id };
}
function authority(char: string) {
  return { effectIdentity: char.repeat(64), requestBodyHash: `sha256:${char.repeat(64)}`,
    providerGeneration: 1 };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "joko-recording-effect-"));
  const store = new OperationalStore(join(root, "orchestrator.db"));
  store.upsertBackend({ id: "pi", displayName: "Pi", version: "fixture", health: "healthy",
    adapterKind: "fixture", instanceGeneration: 0, installationState: "installed",
    authenticationState: "not_required", capabilities: new Map(), models: [], tools: [], diagnostics: [] });
  store.upsertTarget({ id: "local", backendId: "pi", displayName: "Local workspace",
    workspaceRoot: root, managed: false, trusted: true });
  store.createSession({ id: SCOPE.sessionId, backendId: "pi", targetId: SCOPE.targetId,
    title: "Recording task", binding: { opaqueRef: "recording-task", generation: 1 }, pinned: false,
    archived: false, permissionMode: "ask", planMode: false, fastMode: false,
    createdAt: 1, updatedAt: 1 });
  const ownership = new SimulatorOwnershipRegistry(store);
  const instance = ownership.attachViewer(SCOPE, route(ownership.bindExternalDevice(SCOPE, DEVICE)));
  let deviceState = "Booted";
  let driverReady = true;
  let startFailure: Error | undefined;
  let afterStart: (() => void) | undefined;
  let stopFailure: Error | undefined;
  let discardFailure = false;
  const calls: string[] = [];
  const blobs = new Map<string, Buffer>();
  const recordingId = randomUUID();
  const path = join(root, "recording.mov");
  await writeFile(path, MOV);
  const runtime: SimulatorRecordingRuntime = {
    start: async udid => {
      expect(udid).toBe(UDID);
      expect(store.listOperations({ sessionId: SCOPE.sessionId, status: "started" })
        .some(operation => operation.kind === "ios_simulator_recording")).toBe(true);
      calls.push("start");
      if (startFailure) throw startFailure;
      afterStart?.();
      return { recordingId, simulatorUdid: udid };
    },
    stop: async handle => {
      expect(handle.recordingId).toBe(recordingId);
      expect(store.listOperations({ sessionId: SCOPE.sessionId, status: "started" })
        .some(operation => operation.kind === "ios_simulator_recording")).toBe(true);
      calls.push("stop");
      if (stopFailure) throw stopFailure;
      return { file: await open(path, "r"), byteLength: MOV.byteLength };
    },
    isActive: () => true,
    release: async () => { calls.push("release"); },
    discard: async () => {
      calls.push("discard");
      if (discardFailure) { discardFailure = false; throw new Error("Cleanup not yet confirmed."); }
    },
    close: async () => { calls.push("close"); }
  };
  const artifacts = {
    ingestFileHandle: async (file: Awaited<ReturnType<typeof open>>, options: {
      readonly expectedSize: number; readonly beforeFinalize?: () => Promise<void> }) => {
      calls.push("ingest");
      expect(options.expectedSize).toBe(MOV.byteLength);
      await options.beforeFinalize?.();
      const bytes = Buffer.alloc(MOV.byteLength);
      await file.read(bytes, 0, bytes.byteLength, 0);
      const id = randomUUID();
      blobs.set(id, bytes);
      return { id, sha256: createHash("sha256").update(bytes).digest("hex"),
        byteLength: bytes.byteLength, mimeType: "video/quicktime", fileName: "recording.mov" };
    },
    get: async (id: string) => {
      const bytes = blobs.get(id);
      if (!bytes) throw new Error("Missing artifact.");
      return { id, sha256: createHash("sha256").update(bytes).digest("hex"),
        byteLength: bytes.byteLength, mimeType: "video/quicktime" };
    }
  };
  const coordinator = new SimulatorRecordingCoordinator(store, ownership,
    { isReady: () => driverReady } as never, artifacts as never, join(root, "recordings"),
    { runtime, device: { findExact: async () => ({ ...DEVICE, state: deviceState }) } });
  return { root, store, ownership, instance, coordinator, calls, blobs, runtime, artifacts,
    setDeviceState: (value: string) => { deviceState = value; },
    setDriverReady: (value: boolean) => { driverReady = value; },
    setStartFailure: (value: Error) => { startFailure = value; },
    setAfterStart: (value: () => void) => { afterStart = value; },
    setStopFailure: (value: Error) => { stopFailure = value; },
    failNextDiscard: () => { discardFailure = true; },
    close: async () => { await coordinator.close(); store.close();
      await rm(root, { recursive: true, force: true }); } };
}

it("starts once, finalizes a task-owned MOV Artifact and safely replays stop", async () => {
  const h = await fixture();
  try {
    const started = await h.coordinator.start(SCOPE, route(h.instance), authority("a"));
    expect(started).toMatchObject({ replayed: false, receipt: { backend: "simctl",
      instanceId: h.instance.instanceId } });
    expect(await h.coordinator.start(SCOPE, route(h.instance), authority("a")))
      .toMatchObject({ replayed: true, receipt: started.receipt });
    await expect(h.coordinator.start(SCOPE, route(h.instance), authority("b")))
      .rejects.toMatchObject({ code: "RECORDING_ALREADY_ACTIVE" });
    const stopped = await h.coordinator.stop(SCOPE, route(h.instance), started.receipt.recordingId,
      authority("c"));
    expect(stopped).toMatchObject({ replayed: false, receipt: { video: {
      byteLength: MOV.byteLength, mimeType: "video/quicktime" } } });
    expect(h.blobs.get(stopped.receipt.video.id)).toEqual(MOV);
    expect(await h.coordinator.stop(SCOPE, route(h.instance), started.receipt.recordingId,
      authority("c"))).toMatchObject({ replayed: true, receipt: stopped.receipt });
    expect(h.calls.slice(0, 4)).toEqual(["start", "stop", "ingest", "release"]);
    const operations = JSON.stringify(h.store.listOperations({ sessionId: SCOPE.sessionId }),
      (_key, value: unknown) => typeof value === "bigint" ? String(value) : value);
    expect(operations).not.toContain(h.root);
    expect(operations).not.toContain(MOV.toString("base64"));
    await expect(h.coordinator.start(SCOPE, route(h.instance), authority("a")))
      .rejects.toMatchObject({ code: "RECORDING_NOT_FOUND" });
  } finally { await h.close(); }
});

it("rejects unready device, conflicting effects and task-foreign stop before dispatch", async () => {
  const h = await fixture();
  try {
    h.setDeviceState("Shutdown");
    await expect(h.coordinator.start(SCOPE, route(h.instance), authority("d")))
      .rejects.toMatchObject({ code: "SIMULATOR_NOT_READY" });
    h.setDeviceState("Booted");
    h.store.claimDeferredEffectOperation({ id: "other-effect", kind: "ios_simulator_app_control",
      body: { action: "launch_app", sessionId: SCOPE.sessionId } }, () => undefined);
    await expect(h.coordinator.start(SCOPE, route(h.instance), authority("e")))
      .rejects.toMatchObject({ code: "MUTATION_IN_PROGRESS" });
    h.store.failEffectOperation("other-effect", h.store.getOperation("other-effect").bodyHash,
      new Error("fixture settled"));
    const started = await h.coordinator.start(SCOPE, route(h.instance), authority("f"));
    await expect(h.coordinator.stop(SCOPE, route(h.instance), randomUUID(), authority("0")))
      .rejects.toMatchObject({ code: "RECORDING_NOT_FOUND" });
    h.setDriverReady(false);
    await expect(h.coordinator.stop(SCOPE, route(h.instance), started.receipt.recordingId,
      authority("1"))).rejects.toMatchObject({ code: "SIMULATOR_NOT_READY" });
    expect(h.calls).toEqual(["start"]);
  } finally { await h.close(); }
});

it("retains a recording for exact-instance cleanup retry after an uncertain discard", async () => {
  const h = await fixture();
  try {
    await h.coordinator.start(SCOPE, route(h.instance), authority("a"));
    h.failNextDiscard();
    await expect(h.coordinator.discardInstance(h.instance.instanceId))
      .rejects.toThrow("Cleanup not yet confirmed.");
    expect(h.coordinator.hasActive(h.instance.instanceId)).toBe(true);
    await h.coordinator.discardInstance(h.instance.instanceId);
    expect(h.coordinator.hasActive(h.instance.instanceId)).toBe(false);
    expect(h.calls).toEqual(["start", "discard", "discard"]);
  } finally { await h.close(); }
});

it("keeps an uncertain cleanup durably fenced until an exact retry confirms retirement", async () => {
  const h = await fixture();
  try {
    const started = await h.coordinator.start(SCOPE, route(h.instance), authority("a"));
    h.setStopFailure(new Error("Recorder stopped without a response."));
    h.failNextDiscard();
    await expect(h.coordinator.stop(SCOPE, route(h.instance), started.receipt.recordingId,
      authority("b"))).rejects.toMatchObject({ code: "RECORDING_OUTCOME_UNKNOWN" });
    expect(h.coordinator.hasActive(h.instance.instanceId)).toBe(true);
    expect(h.store.listOperations({ sessionId: SCOPE.sessionId, status: "started" })
      .filter(operation => operation.kind === "ios_simulator_recording")).toHaveLength(1);
    await h.coordinator.discardInstance(h.instance.instanceId);
    expect(h.coordinator.hasActive(h.instance.instanceId)).toBe(false);
    expect(h.store.listOperations({ sessionId: SCOPE.sessionId, status: "started" }))
      .toHaveLength(0);
    expect(h.store.listOperations({ sessionId: SCOPE.sessionId, status: "failed" })
      .filter(operation => operation.kind === "ios_simulator_recording")).toHaveLength(1);
  } finally { await h.close(); }
});

it("keeps an uncertain guardian-start cleanup fenced without another dispatch", async () => {
  const h = await fixture();
  try {
    h.setStartFailure(new SimulatorRecordingRuntimeError("RECORDING_OUTCOME_UNKNOWN",
      "Recorder cleanup is unconfirmed.", true));
    await expect(h.coordinator.start(SCOPE, route(h.instance), authority("a")))
      .rejects.toMatchObject({ code: "RECORDING_OUTCOME_UNKNOWN" });
    expect(h.store.listOperations({ sessionId: SCOPE.sessionId, status: "started" })
      .filter(operation => operation.kind === "ios_simulator_recording")).toHaveLength(1);
    await expect(h.coordinator.start(SCOPE, route(h.instance), authority("b")))
      .rejects.toMatchObject({ code: "MUTATION_IN_PROGRESS" });
    expect(h.calls).toEqual(["start"]);
  } finally { await h.close(); }
});

it("retains a returned handle for cleanup retry when readiness drifts after start", async () => {
  const h = await fixture();
  try {
    h.setAfterStart(() => h.setDriverReady(false));
    h.failNextDiscard();
    await expect(h.coordinator.start(SCOPE, route(h.instance), authority("a")))
      .rejects.toMatchObject({ code: "RECORDING_OUTCOME_UNKNOWN" });
    expect(h.coordinator.hasActive(h.instance.instanceId)).toBe(true);
    expect(h.store.listOperations({ sessionId: SCOPE.sessionId, status: "started" })
      .filter(operation => operation.kind === "ios_simulator_recording")).toHaveLength(1);
    await h.coordinator.discardInstance(h.instance.instanceId);
    expect(h.coordinator.hasActive(h.instance.instanceId)).toBe(false);
    expect(h.calls).toEqual(["start", "discard", "discard"]);
  } finally { await h.close(); }
});
