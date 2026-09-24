import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OperationalStore } from "@joko/store";
import { SimulatorLifecycleError } from "@joko/tool-ios-simulator";
import { expect, it } from "vitest";
import { SimulatorOwnershipRegistry, type PublicSimulatorInstance } from "./ios-simulator-ownership.js";
import { compareSimulatorPngBytes,
  SimulatorVisualComparisonCoordinator } from "./ios-simulator-visual-comparison.js";

const SCOPE = { sessionId: "visual-task", targetId: "local", generation: 1 } as const;
const UDID = "A0123456-1234-1234-1234-123456789ABC";
const DEVICE = { udid: UDID, name: "iPhone", state: "Booted", isAvailable: true,
  runtimeIdentifier: "com.apple.CoreSimulator.SimRuntime.iOS-19-0", runtimeName: "iOS 19.0",
  runtimeVersion: "19.0", deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-17",
  lastBootedAt: null } as const;
const BEFORE = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWNgYGD4DwABBAEAfbLI3wAAAABJRU5ErkJggg==", "base64");
const AFTER = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWPQ4OL6DwAB1gE8svJN/gAAAABJRU5ErkJggg==", "base64");

function route(instance: PublicSimulatorInstance) {
  return { instanceId: instance.instanceId, generation: instance.generation, leaseId: instance.lease.id };
}
function authority(char: string) {
  return { effectIdentity: char.repeat(64), requestBodyHash: `sha256:${char.repeat(64)}`,
    providerGeneration: 1 };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "joko-visual-effect-"));
  const store = new OperationalStore(join(root, "orchestrator.db"));
  store.upsertBackend({ id: "pi", displayName: "Pi", version: "fixture", health: "healthy",
    adapterKind: "fixture", instanceGeneration: 0, installationState: "installed",
    authenticationState: "not_required", capabilities: new Map(), models: [], tools: [], diagnostics: [] });
  store.upsertTarget({ id: "local", backendId: "pi", displayName: "Local workspace",
    workspaceRoot: root, managed: false, trusted: true });
  store.createSession({ id: SCOPE.sessionId, backendId: "pi", targetId: SCOPE.targetId,
    title: "Visual task", binding: { opaqueRef: "visual-task", generation: 1 }, pinned: false,
    archived: false, permissionMode: "ask", planMode: false, fastMode: false,
    createdAt: 1, updatedAt: 1 });
  const ownership = new SimulatorOwnershipRegistry(store);
  const instance = ownership.attachViewer(SCOPE, route(ownership.bindExternalDevice(SCOPE, DEVICE)));
  let state = "Booted";
  let capture: () => Promise<Uint8Array> = async () => BEFORE;
  let count = 0;
  const runtime = { findExact: async () => ({ ...DEVICE, state }),
    takeScreenshot: async (udid: string) => {
      expect(udid).toBe(UDID);
      expect(store.listOperations({ sessionId: SCOPE.sessionId, status: "started" })
        .some(operation => operation.kind === "ios_simulator_visual_capture")).toBe(true);
      count += 1;
      return capture();
    } };
  const coordinator = new SimulatorVisualComparisonCoordinator(store, ownership, runtime);
  let storeClosed = false;
  return { root, store, ownership, instance, coordinator, runtime,
    count: () => count, setState: (value: string) => { state = value; },
    setCapture: (value: typeof capture) => { capture = value; },
    closeStore: () => { store.close(); storeClosed = true; },
    close: async () => { if (!storeClosed) store.close();
      await rm(root, { recursive: true, force: true }); } };
}

it("decodes bounded PNGs and reports exact RGBA threshold metrics", async () => {
  expect(await compareSimulatorPngBytes(BEFORE, AFTER, 16)).toEqual({
    width: 1, height: 1, comparedPixels: 1, differentPixels: 1,
    differenceRatio: 1, meanAbsoluteError: 15, maxAbsoluteError: 40, threshold: 16
  });
  await expect(compareSimulatorPngBytes(BEFORE, Buffer.from("not-png"), 16))
    .rejects.toMatchObject({ code: "SCREENSHOT_INVALID" });
  await expect(compareSimulatorPngBytes(BEFORE, Buffer.concat([BEFORE.subarray(0, 8),
    Buffer.from("not-a-png")]), 16)).rejects.toMatchObject({ code: "IMAGE_DECODE_FAILED" });
});

it("captures a private baseline, compares current frame, and replays without recapture", async () => {
  const h = await fixture();
  try {
    const baseline = await h.coordinator.captureBaseline(SCOPE, route(h.instance), authority("a"));
    expect(baseline).toMatchObject({ replayed: false, receipt: {
      baselineId: expect.any(String), instanceId: h.instance.instanceId,
      byteLength: BEFORE.byteLength } });
    h.setCapture(async () => AFTER);
    const diff = await h.coordinator.visualDiff(SCOPE, route(h.instance),
      baseline.receipt.baselineId, 16, authority("b"));
    expect(diff).toMatchObject({ replayed: false, receipt: { baselineId: baseline.receipt.baselineId,
      diff: { differentPixels: 1, meanAbsoluteError: 15, maxAbsoluteError: 40 } } });
    expect(await h.coordinator.captureBaseline(SCOPE, route(h.instance), authority("a")))
      .toMatchObject({ replayed: true, receipt: baseline.receipt });
    expect(await h.coordinator.visualDiff(SCOPE, route(h.instance),
      baseline.receipt.baselineId, 16, authority("b")))
      .toMatchObject({ replayed: true, receipt: diff.receipt });
    expect(h.count()).toBe(2);
    const operationText = JSON.stringify(h.store.listOperations({ sessionId: SCOPE.sessionId }),
      (_key, value: unknown) => typeof value === "bigint" ? String(value) : value);
    expect(operationText).toContain(baseline.receipt.baselineId);
    expect(operationText).not.toContain(BEFORE.toString("base64"));
    expect(operationText).not.toContain(AFTER.toString("base64"));
    h.coordinator.clear(h.instance.instanceId);
    await expect(h.coordinator.visualDiff(SCOPE, route(h.instance), baseline.receipt.baselineId,
      16, authority("8"))).rejects.toMatchObject({ code: "BASELINE_UNAVAILABLE" });
    h.closeStore();
    const reopenedStore = new OperationalStore(join(h.root, "orchestrator.db"));
    try {
      const reopened = new SimulatorVisualComparisonCoordinator(reopenedStore,
        new SimulatorOwnershipRegistry(reopenedStore), {
          findExact: async () => { throw new Error("Replay inspected device"); },
          takeScreenshot: async () => { throw new Error("Replay recaptured"); }
        });
      await expect(reopened.captureBaseline(SCOPE, route(h.instance), authority("a")))
        .rejects.toMatchObject({ code: "BASELINE_UNAVAILABLE" });
      await expect(reopened.visualDiff(SCOPE, route(h.instance), baseline.receipt.baselineId,
        16, authority("b"))).rejects.toMatchObject({ code: "BASELINE_UNAVAILABLE" });
    } finally { reopenedStore.close(); }
  } finally { await h.close(); }
});

it("rejects foreign, evicted, unbooted and conflicting baselines before capture", async () => {
  const h = await fixture();
  try {
    await expect(h.coordinator.visualDiff(SCOPE, route(h.instance), randomUUID(), 16,
      authority("c"))).rejects.toMatchObject({ code: "BASELINE_UNAVAILABLE" });
    await expect(h.coordinator.visualDiff(SCOPE, route(h.instance), randomUUID(), 256,
      authority("d"))).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    h.setState("Shutdown");
    await expect(h.coordinator.captureBaseline(SCOPE, route(h.instance), authority("e")))
      .rejects.toMatchObject({ code: "SIMULATOR_NOT_READY" });
    h.setState("Booted");
    h.store.claimDeferredEffectOperation({ id: "other-effect", kind: "ios_simulator_app_control",
      body: { action: "launch_app", sessionId: SCOPE.sessionId } }, () => undefined);
    await expect(h.coordinator.captureBaseline(SCOPE, route(h.instance), authority("f")))
      .rejects.toMatchObject({ code: "MUTATION_IN_PROGRESS" });
    h.store.failEffectOperation("other-effect", h.store.getOperation("other-effect").bodyHash,
      new Error("fixture settled"));
    const first = await h.coordinator.captureBaseline(SCOPE, route(h.instance), authority("1"));
    const otherScope = { sessionId: "other-visual-task", targetId: SCOPE.targetId, generation: 1 };
    h.store.createSession({ id: otherScope.sessionId, backendId: "pi", targetId: otherScope.targetId,
      title: "Other task", binding: { opaqueRef: "other-visual-task", generation: 1 }, pinned: false,
      archived: false, permissionMode: "ask", planMode: false, fastMode: false,
      createdAt: 1, updatedAt: 1 });
    const otherDevice = { ...DEVICE, udid: "B0123456-1234-1234-1234-123456789ABC" };
    const otherInstance = h.ownership.attachViewer(otherScope,
      route(h.ownership.bindExternalDevice(otherScope, otherDevice)));
    await expect(h.coordinator.visualDiff(otherScope, route(otherInstance), first.receipt.baselineId,
      16, authority("9"))).rejects.toMatchObject({ code: "BASELINE_UNAVAILABLE" });
    for (const char of ["2", "3", "4", "5"]) {
      await h.coordinator.captureBaseline(SCOPE, route(h.instance), authority(char));
    }
    await expect(h.coordinator.visualDiff(SCOPE, route(h.instance), first.receipt.baselineId,
      16, authority("6"))).rejects.toMatchObject({ code: "BASELINE_UNAVAILABLE" });
    expect(h.count()).toBe(5);
  } finally { await h.close(); }
});

it("fences unknown capture and never retries a failed effect identity", async () => {
  const h = await fixture();
  try {
    h.setCapture(async () => { throw new SimulatorLifecycleError("SCREENSHOT_UNKNOWN", "Private host output"); });
    await expect(h.coordinator.captureBaseline(SCOPE, route(h.instance), authority("7")))
      .rejects.toMatchObject({ code: "VISUAL_CAPTURE_UNKNOWN" });
    await expect(h.coordinator.captureBaseline(SCOPE, route(h.instance), authority("7")))
      .rejects.toMatchObject({ code: "VISUAL_CAPTURE_UNKNOWN" });
    expect(h.count()).toBe(1);
  } finally { await h.close(); }
});

it("does not publish a baseline after device drift or caller cancellation", async () => {
  const h = await fixture();
  try {
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(h.coordinator.captureBaseline(SCOPE, route(h.instance), authority("a"),
      cancelled.signal)).rejects.toMatchObject({ code: "MUTATION_CANCELLED" });
    expect(h.count()).toBe(0);
    h.setCapture(async () => { h.setState("Shutdown"); return BEFORE; });
    await expect(h.coordinator.captureBaseline(SCOPE, route(h.instance), authority("b")))
      .rejects.toMatchObject({ code: "VISUAL_CAPTURE_UNKNOWN" });
    await expect(h.coordinator.captureBaseline(SCOPE, route(h.instance), authority("b")))
      .rejects.toMatchObject({ code: "VISUAL_CAPTURE_UNKNOWN" });
    expect(h.count()).toBe(1);
  } finally { await h.close(); }
});
