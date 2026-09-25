import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OperationalStore } from "@joko/store";
import { SimulatorLifecycleError, type SimulatorLifecycleRuntime } from "@joko/tool-ios-simulator";
import { expect, it, vi } from "vitest";
import { SimulatorAppInstallCoordinator } from "./ios-simulator-app-install.js";
import { SimulatorOwnershipRegistry, type PublicSimulatorInstance } from "./ios-simulator-ownership.js";
import { SimulatorAppBuildError, type SimulatorBuildArtifact } from "./ios-simulator-project-build.js";

const SCOPE = { sessionId: "install-task", targetId: "local", generation: 1 } as const;
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
  const root = await mkdtemp(join(tmpdir(), "joko-install-effect-"));
  const store = new OperationalStore(join(root, "orchestrator.db"));
  store.upsertBackend({ id: "pi", displayName: "Pi", version: "fixture", health: "healthy",
    adapterKind: "fixture", instanceGeneration: 0, installationState: "installed",
    authenticationState: "not_required", capabilities: new Map(), models: [], tools: [], diagnostics: [] });
  store.upsertTarget({ id: "local", backendId: "pi", displayName: "Local workspace",
    workspaceRoot: root, managed: false, trusted: true });
  store.createSession({ id: SCOPE.sessionId, backendId: "pi", targetId: SCOPE.targetId,
    title: "Install task", binding: { opaqueRef: "install-task", generation: 1 }, pinned: false,
    archived: false, permissionMode: "ask", planMode: false, fastMode: false,
    createdAt: 1, updatedAt: 1 });
  const ownership = new SimulatorOwnershipRegistry(store);
  const instance = ownership.attachViewer(SCOPE, route(ownership.bindExternalDevice(SCOPE, DEVICE)));
  const artifact: SimulatorBuildArtifact = { artifactId: ARTIFACT_ID, sessionId: SCOPE.sessionId,
    targetId: SCOPE.targetId, bindingGeneration: SCOPE.generation, instanceId: instance.instanceId,
    simulatorUdid: UDID, worktreeRootHash: "a".repeat(64),
    appPath: join(root, "managed", "Application.app"), bundleId: "app.joko.fixture",
    scheme: "Example", projectKind: "xcode-project", createdAt: new Date().toISOString() };
  const calls: string[] = [];
  let install: NonNullable<SimulatorLifecycleRuntime["installApp"]> = async (udid, appPath) => {
    expect(udid).toBe(UDID);
    expect(appPath).toBe(artifact.appPath);
    expect(store.listOperations({ sessionId: SCOPE.sessionId, status: "started" })
      .some(operation => operation.kind === "ios_simulator_app_install")).toBe(true);
    calls.push("install");
  };
  let deviceState: string = "Booted";
  const runtime = { findExact: async () => ({ ...DEVICE, state: deviceState }),
    installApp: async (udid: string, appPath: string, signal?: AbortSignal) =>
      install(udid, appPath, signal) };
  const build = { getArtifact: async (_scope: typeof SCOPE, requestedRoute: ReturnType<typeof route>, id: string) => {
    ownership.requireRoute(SCOPE, requestedRoute);
    if (id !== ARTIFACT_ID) throw new SimulatorAppBuildError("APP_ARTIFACT_INVALID",
      "No task-owned artifact.");
    return artifact;
  } };
  const coordinator = new SimulatorAppInstallCoordinator(store, ownership, build, runtime);
  let storeClosed = false;
  return { root, store, ownership, instance, artifact, coordinator, calls, runtime, build,
    setInstall: (value: typeof install) => { install = value; },
    setDeviceState: (value: string) => { deviceState = value; },
    closeStore: () => { store.close(); storeClosed = true; },
    close: async () => { if (!storeClosed) store.close();
      await rm(root, { recursive: true, force: true }); } };
}

it("claims exact artifact installation before simctl and replays without dispatch after SQLite reopen", async () => {
  const h = await fixture();
  try {
    const heartbeat = vi.spyOn(h.ownership, "heartbeatRoute");
    const first = await h.coordinator.execute(SCOPE, route(h.instance), ARTIFACT_ID, authority("a"));
    expect(first).toMatchObject({ replayed: false, receipt: { artifactId: ARTIFACT_ID,
      bundleId: "app.joko.fixture", backend: "simctl" } });
    expect(h.calls).toEqual(["install"]);
    expect(heartbeat).toHaveBeenCalled();
    const operation = h.store.listOperations({ sessionId: SCOPE.sessionId }).find(value =>
      value.kind === "ios_simulator_app_install");
    expect(operation).toBeDefined();
    expect(JSON.stringify(operation, (_key, value: unknown) =>
      typeof value === "bigint" ? String(value) : value)).not.toContain(h.artifact.appPath);
    h.closeStore();
    const reopenedStore = new OperationalStore(join(h.root, "orchestrator.db"));
    try {
      const reopened = new SimulatorAppInstallCoordinator(reopenedStore,
        new SimulatorOwnershipRegistry(reopenedStore),
        { getArtifact: async () => { throw new Error("Replayed install must not reread the artifact."); } },
        h.runtime);
      const repeated = await reopened.execute(SCOPE, route(h.instance), ARTIFACT_ID, authority("a"));
      expect(repeated).toMatchObject({ replayed: true, receipt: first.receipt });
    } finally { reopenedStore.close(); }
    expect(h.calls).toEqual(["install"]);
  } finally { await h.close(); }
});

it("rejects an unbooted exact device and a concurrent Simulator effect before install", async () => {
  const h = await fixture();
  try {
    h.setDeviceState("Shutdown");
    await expect(h.coordinator.execute(SCOPE, route(h.instance), ARTIFACT_ID, authority("b")))
      .rejects.toMatchObject({ code: "SIMULATOR_NOT_READY" });
    expect(h.calls).toEqual([]);
    h.setDeviceState("Booted");
    await expect(h.coordinator.execute(SCOPE, route(h.instance),
      "f0123456-1234-1234-1234-123456789abc", authority("e")))
      .rejects.toMatchObject({ code: "APP_ARTIFACT_INVALID" });
    h.store.claimDeferredEffectOperation({ id: "other-effect", kind: "ios_simulator_app_build",
      body: { action: "build_app", sessionId: SCOPE.sessionId } }, () => undefined);
    await expect(h.coordinator.execute(SCOPE, route(h.instance), ARTIFACT_ID, authority("c")))
      .rejects.toMatchObject({ code: "MUTATION_IN_PROGRESS" });
    expect(h.calls).toEqual([]);
  } finally { await h.close(); }
});

it("keeps an uncertain dispatched install fenced from same-id replay", async () => {
  const h = await fixture();
  try {
    h.setInstall(async () => { h.calls.push("install");
      throw new SimulatorLifecycleError("APP_INSTALL_UNKNOWN", "Private host output"); });
    await expect(h.coordinator.execute(SCOPE, route(h.instance), ARTIFACT_ID, authority("d")))
      .rejects.toMatchObject({ code: "APP_INSTALL_UNKNOWN" });
    await expect(h.coordinator.execute(SCOPE, route(h.instance), ARTIFACT_ID, authority("d")))
      .rejects.toMatchObject({ code: "APP_INSTALL_UNKNOWN" });
    expect(h.calls).toEqual(["install"]);
  } finally { await h.close(); }
});
