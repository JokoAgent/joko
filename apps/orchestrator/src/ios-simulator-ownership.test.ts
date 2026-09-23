import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OperationalStore } from "@joko/store";
import { expect, it } from "vitest";
import { SimulatorOwnershipRegistry } from "./ios-simulator-ownership.js";

const DEVICE = {
  udid: "A0123456-1234-1234-1234-123456789ABC",
  name: "iPhone test",
  state: "Shutdown",
  isAvailable: true,
  runtimeIdentifier: "com.apple.CoreSimulator.SimRuntime.iOS-19-0",
  runtimeName: "iOS 19.0",
  runtimeVersion: "19.0",
  deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-17",
  lastBootedAt: null
} as const;

function seed(store: OperationalStore): void {
  store.upsertBackend({ id: "pi", displayName: "Pi", version: "fixture", health: "healthy",
    adapterKind: "fixture", instanceGeneration: 0, installationState: "installed",
    authenticationState: "not_required", capabilities: new Map(), models: [], tools: [], diagnostics: [] });
  store.upsertTarget({ id: "target", backendId: "pi", displayName: "Local workspace",
    workspaceRoot: "D:/workspace", managed: false, trusted: true });
  for (const id of ["first", "second"]) store.createSession({ id, backendId: "pi", targetId: "target", title: id,
    binding: { opaqueRef: id, generation: 1 }, pinned: false, archived: false,
    permissionMode: "ask", planMode: false, fastMode: false, createdAt: 1, updatedAt: 1 });
}

it("persists exact task and device ownership without exposing another task or stale route", async () => {
  const directory = await mkdtemp(join(tmpdir(), "joko-simulator-ownership-"));
  const path = join(directory, "store.db");
  let store: OperationalStore | undefined;
  try {
    store = new OperationalStore(path);
    seed(store);
    let now = 1_000;
    const registry = new SimulatorOwnershipRegistry(store, { now: () => now });
    const first = { sessionId: "first", targetId: "target", generation: 1 };
    const second = { sessionId: "second", targetId: "target", generation: 1 };
    const attached = registry.bindExternalDevice(first, DEVICE);
    expect(attached).toMatchObject({ sessionId: "first", simulatorUdid: DEVICE.udid, generation: 1,
      lifecycleState: "stopped", viewerState: "detached", lease: { expiresAt: 61_000 } });
    expect(JSON.stringify(attached)).not.toContain("D:/workspace");
    expect(registry.listForTask(second)).toEqual([]);
    expect(() => registry.bindExternalDevice(second, DEVICE)).toThrow(/another task/u);
    expect(() => registry.bindExternalDevice(first, { ...DEVICE, udid: "B0123456-1234-1234-1234-123456789ABC" }))
      .toThrow(/already owns/u);
    store.close();
    store = new OperationalStore(path);
    const restored = new SimulatorOwnershipRegistry(store, { now: () => now });
    expect(restored.listForTask(first)[0]?.instanceId).toBe(attached.instanceId);
    now = 62_000;
    expect(restored.listForTask(first)[0]?.lease.id).not.toBe(attached.lease.id);
    expect(() => restored.listForTask({ ...first, generation: 2 })).toThrow(/stale/u);
    store.upsertTarget({ ...store.getTarget("target").descriptor, workspaceRoot: "D:/different" });
    expect(() => restored.listForTask(first)).toThrow(/no longer matches/u);
    expect(restored.listForTask(second)).toEqual([]);
  } finally {
    store?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it("rejects an invalid persisted registry as a whole", () => {
  const store = new OperationalStore(":memory:");
  seed(store);
  store.setSetting("service", "orchestrator", "ios_simulator_ownership.v1", { format: 1, instances: [{ instanceId: "partial" }] });
  expect(() => new SimulatorOwnershipRegistry(store)).toThrow(/invalid/u);
  store.close();
});
