import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OperationalStore } from "@joko/store";
import { SimulatorLifecycleError } from "@joko/tool-ios-simulator";
import { expect, it } from "vitest";
import { SimulatorAppControlCoordinator } from "./ios-simulator-app-control.js";
import { SimulatorOwnershipRegistry, type PublicSimulatorInstance } from "./ios-simulator-ownership.js";
import type { SimulatorBuildArtifact } from "./ios-simulator-project-build.js";

const SCOPE = { sessionId: "app-control-task", targetId: "local", generation: 1 } as const;
const UDID = "A0123456-1234-1234-1234-123456789ABC";
const ARTIFACT_ID = "e0123456-1234-1234-1234-123456789abc";
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

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "joko-app-control-"));
  const store = new OperationalStore(join(root, "orchestrator.db"));
  store.upsertBackend({ id: "pi", displayName: "Pi", version: "fixture", health: "healthy",
    adapterKind: "fixture", instanceGeneration: 0, installationState: "installed",
    authenticationState: "not_required", capabilities: new Map(), models: [], tools: [], diagnostics: [] });
  store.upsertTarget({ id: "local", backendId: "pi", displayName: "Local workspace",
    workspaceRoot: root, managed: false, trusted: true });
  store.createSession({ id: SCOPE.sessionId, backendId: "pi", targetId: SCOPE.targetId,
    title: "App control task", binding: { opaqueRef: "app-control-task", generation: 1 },
    pinned: false, archived: false, permissionMode: "ask", planMode: false, fastMode: false,
    createdAt: 1, updatedAt: 1 });
  const ownership = new SimulatorOwnershipRegistry(store);
  const instance = ownership.attachViewer(SCOPE, route(ownership.bindExternalDevice(SCOPE, DEVICE)));
  const artifact: SimulatorBuildArtifact = { artifactId: ARTIFACT_ID, sessionId: SCOPE.sessionId,
    targetId: SCOPE.targetId, bindingGeneration: SCOPE.generation, instanceId: instance.instanceId,
    simulatorUdid: UDID, worktreeRootHash: "a".repeat(64), appPath: join(root, "Application.app"),
    bundleId: "app.joko.fixture", scheme: "Example", projectKind: "xcode-project",
    createdAt: new Date().toISOString() };
  const calls: string[] = [];
  const invalidations: string[] = [];
  let deviceState = "Booted";
  let launch: (args: readonly string[]) => Promise<void> = async args => {
    expect(args).toEqual(["--token", "private-launch-value"]);
    expect(store.listOperations({ sessionId: SCOPE.sessionId, status: "started" })
      .some(operation => operation.kind === "ios_simulator_app_control")).toBe(true);
    calls.push("launch");
  };
  const runtime = { findExact: async () => ({ ...DEVICE, state: deviceState }),
    launchApp: async (udid: string, bundleId: string, args: readonly string[]) => {
      expect(udid).toBe(UDID);
      expect(bundleId).toBe(artifact.bundleId);
      await launch(args);
    },
    terminateApp: async (udid: string, bundleId: string) => {
      expect(udid).toBe(UDID);
      expect(bundleId).toBe(artifact.bundleId);
      calls.push("terminate");
    } };
  const build = { getArtifact: async () => artifact };
  const screen = { invalidateOwnedRoute: () => { invalidations.push("invalidate");
    return invalidations.length; } };
  const coordinator = new SimulatorAppControlCoordinator(store, ownership, build, screen, runtime);
  let storeClosed = false;
  return { root, store, ownership, instance, artifact, coordinator, calls, invalidations,
    runtime, build, screen,
    setDeviceState: (value: string) => { deviceState = value; },
    setLaunch: (value: typeof launch) => { launch = value; },
    closeStore: () => { store.close(); storeClosed = true; },
    close: async () => { if (!storeClosed) store.close();
      await rm(root, { recursive: true, force: true }); } };
}

it("launches and terminates the exact bundle after claim without persisting arguments", async () => {
  const h = await fixture();
  try {
    const action = { type: "launch_app", artifactId: ARTIFACT_ID,
      args: ["--token", "private-launch-value"] } as const;
    const launched = await h.coordinator.execute(SCOPE, route(h.instance), action, authority("a"));
    expect(launched).toMatchObject({ replayed: false, receipt: { action: "launch_app",
      artifactId: ARTIFACT_ID, bundleId: "app.joko.fixture" } });
    expect(h.calls).toEqual(["launch"]);
    expect(h.invalidations).toEqual(["invalidate"]);
    const operations = h.store.listOperations({ sessionId: SCOPE.sessionId });
    expect(JSON.stringify(operations, (_key, value: unknown) =>
      typeof value === "bigint" ? String(value) : value)).not.toContain("private-launch-value");
    const terminated = await h.coordinator.execute(SCOPE, route(h.instance),
      { type: "terminate_app", artifactId: ARTIFACT_ID }, authority("b"));
    expect(terminated).toMatchObject({ replayed: false, receipt: { action: "terminate_app" } });
    expect(h.calls).toEqual(["launch", "terminate"]);
    expect(h.invalidations).toHaveLength(2);
    h.closeStore();
    const reopenedStore = new OperationalStore(join(h.root, "orchestrator.db"));
    try {
      const reopened = new SimulatorAppControlCoordinator(reopenedStore,
        new SimulatorOwnershipRegistry(reopenedStore),
        { getArtifact: async () => { throw new Error("Replay must not read the artifact."); } },
        h.screen, h.runtime);
      expect(await reopened.execute(SCOPE, route(h.instance), action, authority("a")))
        .toMatchObject({ replayed: true, receipt: launched.receipt });
      expect(h.calls).toEqual(["launch", "terminate"]);
      expect(h.invalidations).toHaveLength(2);
    } finally { reopenedStore.close(); }
  } finally { await h.close(); }
});

it("rejects invalid arguments and unbooted devices before dispatch", async () => {
  const h = await fixture();
  try {
    await expect(h.coordinator.execute(SCOPE, route(h.instance),
      { type: "launch_app", artifactId: ARTIFACT_ID, args: ["x".repeat(4_097)] }, authority("c")))
      .rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    h.setDeviceState("Shutdown");
    await expect(h.coordinator.execute(SCOPE, route(h.instance),
      { type: "terminate_app", artifactId: ARTIFACT_ID }, authority("d")))
      .rejects.toMatchObject({ code: "SIMULATOR_NOT_READY" });
    h.setDeviceState("Booted");
    h.store.claimDeferredEffectOperation({ id: "other-effect", kind: "ios_simulator_app_install",
      body: { action: "install_app", sessionId: SCOPE.sessionId } }, () => undefined);
    await expect(h.coordinator.execute(SCOPE, route(h.instance),
      { type: "launch_app", artifactId: ARTIFACT_ID, args: [] }, authority("f")))
      .rejects.toMatchObject({ code: "MUTATION_IN_PROGRESS" });
    expect(h.calls).toEqual([]);
  } finally { await h.close(); }
});

it("fences a dispatched unknown launch from same-id replay", async () => {
  const h = await fixture();
  try {
    h.setLaunch(async () => { h.calls.push("launch");
      throw new SimulatorLifecycleError("APP_LAUNCH_UNKNOWN", "Private host output"); });
    const action = { type: "launch_app", artifactId: ARTIFACT_ID, args: [] } as const;
    await expect(h.coordinator.execute(SCOPE, route(h.instance), action, authority("e")))
      .rejects.toMatchObject({ code: "APP_CONTROL_UNKNOWN" });
    await expect(h.coordinator.execute(SCOPE, route(h.instance), action, authority("e")))
      .rejects.toMatchObject({ code: "APP_CONTROL_UNKNOWN" });
    expect(h.calls).toEqual(["launch"]);
    expect(h.invalidations).toEqual([]);
  } finally { await h.close(); }
});
