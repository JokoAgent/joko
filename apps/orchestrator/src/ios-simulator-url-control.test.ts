import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OperationalStore } from "@joko/store";
import { SimulatorLifecycleError } from "@joko/tool-ios-simulator";
import { expect, it } from "vitest";
import { SimulatorOwnershipRegistry, type PublicSimulatorInstance } from "./ios-simulator-ownership.js";
import { SimulatorUrlControlCoordinator } from "./ios-simulator-url-control.js";

const SCOPE = { sessionId: "url-task", targetId: "local", generation: 1 } as const;
const UDID = "A0123456-1234-1234-1234-123456789ABC";
const DEVICE = { udid: UDID, name: "iPhone", state: "Booted", isAvailable: true,
  runtimeIdentifier: "com.apple.CoreSimulator.SimRuntime.iOS-19-0", runtimeName: "iOS 19.0",
  runtimeVersion: "19.0", deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-17",
  lastBootedAt: null } as const;
const PRIVATE_URL = "myapp://screen?token=private-url-value";

function route(instance: PublicSimulatorInstance) {
  return { instanceId: instance.instanceId, generation: instance.generation, leaseId: instance.lease.id };
}
function authority(char: string) {
  return { effectIdentity: char.repeat(64), requestBodyHash: `sha256:${char.repeat(64)}`,
    providerGeneration: 1 };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "joko-url-effect-"));
  const store = new OperationalStore(join(root, "orchestrator.db"));
  store.upsertBackend({ id: "pi", displayName: "Pi", version: "fixture", health: "healthy",
    adapterKind: "fixture", instanceGeneration: 0, installationState: "installed",
    authenticationState: "not_required", capabilities: new Map(), models: [], tools: [], diagnostics: [] });
  store.upsertTarget({ id: "local", backendId: "pi", displayName: "Local workspace",
    workspaceRoot: root, managed: false, trusted: true });
  store.createSession({ id: SCOPE.sessionId, backendId: "pi", targetId: SCOPE.targetId,
    title: "URL task", binding: { opaqueRef: "url-task", generation: 1 }, pinned: false,
    archived: false, permissionMode: "ask", planMode: false, fastMode: false,
    createdAt: 1, updatedAt: 1 });
  const ownership = new SimulatorOwnershipRegistry(store);
  const instance = ownership.attachViewer(SCOPE, route(ownership.bindExternalDevice(SCOPE, DEVICE)));
  const calls: string[] = [];
  const invalidations: string[] = [];
  let deviceState = "Booted";
  let open: (url: string) => Promise<void> = async url => {
    expect(url).toBe(PRIVATE_URL);
    expect(store.listOperations({ sessionId: SCOPE.sessionId, status: "started" })
      .some(operation => operation.kind === "ios_simulator_url_control")).toBe(true);
    calls.push("open");
  };
  const runtime = { findExact: async () => ({ ...DEVICE, state: deviceState }),
    openSimulatorUrl: async (udid: string, url: string) => {
      expect(udid).toBe(UDID);
      await open(url);
    } };
  const screen = { invalidateOwnedRoute: () => { invalidations.push("invalidate");
    return invalidations.length; } };
  const coordinator = new SimulatorUrlControlCoordinator(store, ownership, screen, runtime);
  let storeClosed = false;
  return { root, store, ownership, instance, coordinator, calls, invalidations, screen, runtime,
    setDeviceState: (value: string) => { deviceState = value; },
    setOpen: (value: typeof open) => { open = value; },
    closeStore: () => { store.close(); storeClosed = true; },
    close: async () => { if (!storeClosed) store.close();
      await rm(root, { recursive: true, force: true }); } };
}

it("claims URL delivery before simctl and replays without URL disclosure after SQLite reopen", async () => {
  const h = await fixture();
  try {
    const opened = await h.coordinator.execute(SCOPE, route(h.instance), PRIVATE_URL, authority("a"));
    expect(opened).toMatchObject({ replayed: false, receipt: { opened: true, backend: "simctl" } });
    expect(h.calls).toEqual(["open"]);
    expect(h.invalidations).toEqual(["invalidate"]);
    expect(JSON.stringify(h.store.listOperations({ sessionId: SCOPE.sessionId }),
      (_key, value: unknown) => typeof value === "bigint" ? String(value) : value))
      .not.toContain(PRIVATE_URL);
    h.closeStore();
    const reopenedStore = new OperationalStore(join(h.root, "orchestrator.db"));
    try {
      const reopened = new SimulatorUrlControlCoordinator(reopenedStore,
        new SimulatorOwnershipRegistry(reopenedStore), h.screen,
        { findExact: async () => { throw new Error("Replay must not inspect the device."); },
          openSimulatorUrl: async () => { throw new Error("Replay must not dispatch."); } });
      expect(await reopened.execute(SCOPE, route(h.instance), PRIVATE_URL, authority("a")))
        .toMatchObject({ replayed: true, receipt: opened.receipt });
      expect(h.calls).toEqual(["open"]);
      expect(h.invalidations).toHaveLength(1);
    } finally { reopenedStore.close(); }
  } finally { await h.close(); }
});

it("rejects file URLs, unbooted devices and concurrent Simulator effects before dispatch", async () => {
  const h = await fixture();
  try {
    await expect(h.coordinator.execute(SCOPE, route(h.instance), "file:///private/data",
      authority("b"))).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    h.setDeviceState("Shutdown");
    await expect(h.coordinator.execute(SCOPE, route(h.instance), PRIVATE_URL,
      authority("c"))).rejects.toMatchObject({ code: "SIMULATOR_NOT_READY" });
    h.setDeviceState("Booted");
    h.store.claimDeferredEffectOperation({ id: "other-effect", kind: "ios_simulator_app_control",
      body: { action: "launch_app", sessionId: SCOPE.sessionId } }, () => undefined);
    await expect(h.coordinator.execute(SCOPE, route(h.instance), PRIVATE_URL,
      authority("d"))).rejects.toMatchObject({ code: "MUTATION_IN_PROGRESS" });
    expect(h.calls).toEqual([]);
  } finally { await h.close(); }
});

it("fences an unknown dispatched URL from same-id replay", async () => {
  const h = await fixture();
  try {
    h.setOpen(async () => { h.calls.push("open");
      throw new SimulatorLifecycleError("OPEN_URL_UNKNOWN", "Private host output"); });
    await expect(h.coordinator.execute(SCOPE, route(h.instance), PRIVATE_URL,
      authority("e"))).rejects.toMatchObject({ code: "OPEN_URL_UNKNOWN" });
    await expect(h.coordinator.execute(SCOPE, route(h.instance), PRIVATE_URL,
      authority("e"))).rejects.toMatchObject({ code: "OPEN_URL_UNKNOWN" });
    expect(h.calls).toEqual(["open"]);
  } finally { await h.close(); }
});
