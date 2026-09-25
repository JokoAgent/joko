import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OperationalStore } from "@joko/store";
import { SimulatorLifecycleError } from "@joko/tool-ios-simulator";
import { expect, it } from "vitest";
import { SimulatorOwnershipRegistry, type PublicSimulatorInstance } from "./ios-simulator-ownership.js";
import { SimulatorScreenshotCoordinator } from "./ios-simulator-screenshot.js";

const SCOPE = { sessionId: "screenshot-task", targetId: "local", generation: 1 } as const;
const UDID = "A0123456-1234-1234-1234-123456789ABC";
const DEVICE = { udid: UDID, name: "iPhone", state: "Booted", isAvailable: true,
  runtimeIdentifier: "com.apple.CoreSimulator.SimRuntime.iOS-19-0", runtimeName: "iOS 19.0",
  runtimeVersion: "19.0", deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-17",
  lastBootedAt: null } as const;
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);

function route(instance: PublicSimulatorInstance) {
  return { instanceId: instance.instanceId, generation: instance.generation, leaseId: instance.lease.id };
}
function authority(char: string) {
  return { effectIdentity: char.repeat(64), requestBodyHash: `sha256:${char.repeat(64)}`,
    providerGeneration: 1 };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "joko-screenshot-effect-"));
  const store = new OperationalStore(join(root, "orchestrator.db"));
  store.upsertBackend({ id: "pi", displayName: "Pi", version: "fixture", health: "healthy",
    adapterKind: "fixture", instanceGeneration: 0, installationState: "installed",
    authenticationState: "not_required", capabilities: new Map(), models: [], tools: [], diagnostics: [] });
  store.upsertTarget({ id: "local", backendId: "pi", displayName: "Local workspace",
    workspaceRoot: root, managed: false, trusted: true });
  store.createSession({ id: SCOPE.sessionId, backendId: "pi", targetId: SCOPE.targetId,
    title: "Screenshot task", binding: { opaqueRef: "screenshot-task", generation: 1 }, pinned: false,
    archived: false, permissionMode: "ask", planMode: false, fastMode: false,
    createdAt: 1, updatedAt: 1 });
  const ownership = new SimulatorOwnershipRegistry(store);
  const instance = ownership.attachViewer(SCOPE, route(ownership.bindExternalDevice(SCOPE, DEVICE)));
  let state = "Booted";
  let capture: () => Promise<Uint8Array> = async () => PNG;
  const calls: string[] = [];
  const blobs = new Map<string, Uint8Array>();
  const artifacts = {
    ingestBytes: async (bytes: Uint8Array) => {
      calls.push("ingest");
      const id = randomUUID();
      blobs.set(id, bytes);
      return { id, sha256: createHash("sha256").update(bytes).digest("hex"),
        byteLength: bytes.byteLength, mimeType: "image/png", fileName: "capture.png" };
    },
    get: async (id: string) => {
      const bytes = blobs.get(id);
      if (!bytes) throw new Error("Missing artifact");
      return { id, sha256: createHash("sha256").update(bytes).digest("hex"),
        byteLength: bytes.byteLength, mimeType: "image/png" };
    }
  };
  const runtime = { findExact: async () => ({ ...DEVICE, state }),
    takeScreenshot: async (udid: string) => {
      expect(udid).toBe(UDID);
      expect(store.listOperations({ sessionId: SCOPE.sessionId, status: "started" })
        .some(operation => operation.kind === "ios_simulator_screenshot")).toBe(true);
      calls.push("capture");
      return capture();
    } };
  const coordinator = new SimulatorScreenshotCoordinator(store, ownership, artifacts as never, runtime);
  let storeClosed = false;
  return { root, store, ownership, instance, coordinator, calls, blobs, artifacts, runtime,
    setState: (value: string) => { state = value; },
    setCapture: (value: typeof capture) => { capture = value; },
    closeStore: () => { store.close(); storeClosed = true; },
    close: async () => { if (!storeClosed) store.close();
      await rm(root, { recursive: true, force: true }); } };
}

it("stores one task-bound PNG receipt before replay, without repeating capture after SQLite reopen", async () => {
  const h = await fixture();
  try {
    const captured = await h.coordinator.execute(SCOPE, route(h.instance), authority("a"));
    expect(captured).toMatchObject({ replayed: false, receipt: { backend: "simctl",
      instanceId: h.instance.instanceId, image: { byteLength: PNG.byteLength, mimeType: "image/png" } } });
    expect(h.calls).toEqual(["capture", "ingest"]);
    expect(h.blobs.get(captured.receipt.image.id)).toEqual(PNG);
    const operationText = JSON.stringify(h.store.listOperations({ sessionId: SCOPE.sessionId }),
      (_key, value: unknown) => typeof value === "bigint" ? String(value) : value);
    expect(operationText).toContain(captured.receipt.image.id);
    expect(operationText).not.toContain(PNG.toString("base64"));
    h.closeStore();
    const reopenedStore = new OperationalStore(join(h.root, "orchestrator.db"));
    try {
      const replay = new SimulatorScreenshotCoordinator(reopenedStore,
        new SimulatorOwnershipRegistry(reopenedStore), h.artifacts as never,
        { findExact: async () => { throw new Error("Replay inspected device"); },
          takeScreenshot: async () => { throw new Error("Replay recaptured"); } });
      expect(await replay.execute(SCOPE, route(h.instance), authority("a")))
        .toMatchObject({ replayed: true, receipt: captured.receipt });
      expect(h.calls).toEqual(["capture", "ingest"]);
    } finally { reopenedStore.close(); }
  } finally { await h.close(); }
});

it("rejects unbooted and conflicting Simulator effects before capture, and fences unknown capture", async () => {
  const h = await fixture();
  try {
    h.setState("Shutdown");
    await expect(h.coordinator.execute(SCOPE, route(h.instance), authority("b")))
      .rejects.toMatchObject({ code: "SIMULATOR_NOT_READY" });
    h.setState("Booted");
    h.store.claimDeferredEffectOperation({ id: "other-effect", kind: "ios_simulator_app_control",
      body: { action: "launch_app", sessionId: SCOPE.sessionId } }, () => undefined);
    await expect(h.coordinator.execute(SCOPE, route(h.instance), authority("c")))
      .rejects.toMatchObject({ code: "MUTATION_IN_PROGRESS" });
    h.store.failEffectOperation("other-effect", h.store.getOperation("other-effect").bodyHash,
      new Error("fixture settled"));
    h.setCapture(async () => { throw new SimulatorLifecycleError("SCREENSHOT_UNKNOWN", "Private host output"); });
    await expect(h.coordinator.execute(SCOPE, route(h.instance), authority("d")))
      .rejects.toMatchObject({ code: "SCREENSHOT_UNKNOWN" });
    await expect(h.coordinator.execute(SCOPE, route(h.instance), authority("d")))
      .rejects.toMatchObject({ code: "SCREENSHOT_UNKNOWN" });
    expect(h.calls).toEqual(["capture"]);
  } finally { await h.close(); }
});
