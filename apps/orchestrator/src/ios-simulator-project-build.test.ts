import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OperationalStore } from "@joko/store";
import { SimulatorAppArtifactError, SimulatorProjectBuildError,
  type SimulatorProjectBuilder } from "@joko/tool-ios-simulator";
import { expect, it } from "vitest";
import { SimulatorOwnershipRegistry, type PublicSimulatorInstance } from "./ios-simulator-ownership.js";
import { SimulatorProjectBuildCoordinator } from "./ios-simulator-project-build.js";

const SCOPE = { sessionId: "build-task", targetId: "local", generation: 1 } as const;
const UDID = "A0123456-1234-1234-1234-123456789ABC";
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
  const root = await mkdtemp(join(tmpdir(), "joko-build-effect-"));
  const workspace = join(root, "workspace");
  const sourceApp = join(workspace, "Build", "Example.app");
  await mkdir(sourceApp, { recursive: true });
  await mkdir(join(workspace, "Example.xcodeproj"));
  await writeFile(join(sourceApp, "Info.plist"), "fixture");
  const databasePath = join(root, "orchestrator.db");
  const store = new OperationalStore(databasePath);
  store.upsertBackend({ id: "pi", displayName: "Pi", version: "fixture", health: "healthy",
    adapterKind: "fixture", instanceGeneration: 0, installationState: "installed",
    authenticationState: "not_required", capabilities: new Map(), models: [], tools: [], diagnostics: [] });
  store.upsertTarget({ id: "local", backendId: "pi", displayName: "Local workspace",
    workspaceRoot: workspace, managed: false, trusted: true });
  store.createSession({ id: SCOPE.sessionId, backendId: "pi", targetId: SCOPE.targetId,
    title: "Build task", binding: { opaqueRef: "build-task", generation: 1 }, pinned: false,
    archived: false, permissionMode: "ask", planMode: false, fastMode: false,
    createdAt: 1, updatedAt: 1 });
  const ownership = new SimulatorOwnershipRegistry(store);
  const instance = ownership.attachViewer(SCOPE, route(ownership.bindExternalDevice(SCOPE, DEVICE)));
  const calls: string[] = [];
  let build: NonNullable<SimulatorProjectBuilder["build"]> = async input => {
    expect(input.simulatorUdid).toBe(UDID);
    expect(store.listOperations({ sessionId: SCOPE.sessionId, status: "started" })
      .some(operation => operation.kind === "ios_simulator_app_build")).toBe(true);
    calls.push("build");
    return { kind: "xcode-project", worktreeRoot: workspace, projectRoot: workspace,
      containerPath: join(workspace, "Example.xcodeproj"), scheme: "Example",
      appPath: sourceApp, resultBundlePath: null, buildLogTail: "BUILD SUCCEEDED",
      outputTruncated: false };
  };
  const builder: Pick<SimulatorProjectBuilder, "inspect" | "build" | "readXcresult"> = {
    inspect: async () => ({ kind: "xcode-project", worktreeRoot: workspace,
      projectRoot: workspace, containerPath: join(workspace, "Example.xcodeproj") }),
    build: input => build(input),
    readXcresult: async () => "{}"
  };
  const options = { artifactRoot: join(root, "managed"), builder,
    inspectArtifact: async ({ appPath }: { appPath: string }) => ({ appPath, bundleId: "app.joko.example",
      executable: "Example" }), architecture: "x86_64" as const };
  const coordinator = new SimulatorProjectBuildCoordinator(store, ownership, options);
  let storeClosed = false;
  return { root, store, ownership, instance, coordinator, options, calls, databasePath,
    setBuild: (value: typeof build) => { build = value; },
    markStoreClosed: () => { storeClosed = true; },
    close: async () => { if (!storeClosed) store.close();
      await rm(root, { recursive: true, force: true }); } };
}

it("claims a build before dispatch and replays its task-owned immutable artifact", async () => {
  const h = await fixture();
  try {
    const first = await h.coordinator.execute(SCOPE, route(h.instance), {}, authority("a"));
    expect(first).toMatchObject({ replayed: false, receipt: { artifact: {
      bundleId: "app.joko.example", scheme: "Example", projectKind: "xcode-project" },
      diagnostics: { xcresultAvailable: false } } });
    expect(h.calls).toEqual(["build"]);
    const artifact = await h.coordinator.getArtifact(SCOPE, route(h.instance), first.receipt.artifact.artifactId);
    expect(artifact.appPath).toContain("Application.app");
    expect(artifact.appPath).not.toBe(join(h.root, "workspace", "Build", "Example.app"));
    expect(await h.coordinator.readDiagnostics(SCOPE, first.receipt.diagnostics.diagnosticsId,
      "build-log", 0, 5)).toMatchObject({ text: "BUILD", nextOffset: 5, eof: false });
    expect(await h.coordinator.readDiagnostics(SCOPE, first.receipt.diagnostics.diagnosticsId,
      "xcresult")).toMatchObject({ available: false, text: "", eof: true });
    await expect(h.coordinator.readDiagnostics({ ...SCOPE, sessionId: "other-task" },
      first.receipt.diagnostics.diagnosticsId, "build-log")).rejects.toBeTruthy();
    h.store.close();
    h.markStoreClosed();
    const resumedStore = new OperationalStore(h.databasePath);
    try {
      const resumedOwnership = new SimulatorOwnershipRegistry(resumedStore);
      const resumed = new SimulatorProjectBuildCoordinator(resumedStore, resumedOwnership, h.options);
      expect(await resumed.execute(SCOPE, route(h.instance), {}, authority("a")))
        .toMatchObject({ replayed: true, receipt: first.receipt });
      expect(h.calls).toEqual(["build"]);
    } finally { resumedStore.close(); }
  } finally { await h.close(); }
});

it("returns bounded redacted diagnostics for a definite Xcode failure without retrying that effect", async () => {
  const h = await fixture();
  try {
    h.setBuild(async () => { h.calls.push("failed-build");
      throw new SimulatorProjectBuildError("APP_BUILD_FAILED", "The Xcode app build failed.",
        `Bearer secretvalue123\n${join(h.root, "workspace", "Sources", "file.swift")}: error: compile failed`); });
    let diagnosticId = "";
    try { await h.coordinator.execute(SCOPE, route(h.instance), {}, authority("b")); }
    catch (error) {
      expect(error).toMatchObject({ code: "APP_BUILD_FAILED", diagnostics: { xcresultAvailable: false } });
      diagnosticId = (error as { diagnostics: { diagnosticsId: string } }).diagnostics.diagnosticsId;
    }
    expect(diagnosticId).not.toBe("");
    const output = await h.coordinator.readDiagnostics(SCOPE, diagnosticId, "build-log");
    expect(output.text).toContain("compile failed");
    expect(output.text).not.toContain("secretvalue123");
    expect(output.text).not.toContain(join(h.root, "workspace"));
    const stored = h.store.listOperations({ sessionId: SCOPE.sessionId });
    expect(JSON.stringify(stored, (_key, value: unknown) => typeof value === "bigint"
      ? value.toString() : value)).not.toContain("secretvalue123");
    await expect(h.coordinator.execute(SCOPE, route(h.instance), {}, authority("b")))
      .rejects.toMatchObject({ code: "APP_BUILD_FAILED" });
    expect(h.calls).toEqual(["failed-build"]);
  } finally { await h.close(); }
});

it("serializes an app build with other Simulator effects", async () => {
  const h = await fixture();
  try {
    h.store.claimDeferredEffectOperation({ id: "other-input", kind: "ios_simulator_input",
      body: { sessionId: SCOPE.sessionId } });
    await expect(h.coordinator.execute(SCOPE, route(h.instance), {}, authority("c")))
      .rejects.toMatchObject({ code: "MUTATION_IN_PROGRESS" });
    expect(h.calls).toEqual([]);
  } finally { await h.close(); }
});

it("retains only two immutable app copies per instance while preserving successful effect replay", async () => {
  const h = await fixture();
  try {
    const first = await h.coordinator.execute(SCOPE, route(h.instance), {}, authority("d"));
    await h.coordinator.execute(SCOPE, route(h.instance), {}, authority("e"));
    await h.coordinator.execute(SCOPE, route(h.instance), {}, authority("f"));
    await expect(h.coordinator.getArtifact(SCOPE, route(h.instance),
      first.receipt.artifact.artifactId)).rejects.toMatchObject({ code: "APP_ARTIFACT_INVALID" });
    expect(await h.coordinator.execute(SCOPE, route(h.instance), {}, authority("d")))
      .toMatchObject({ replayed: true, receipt: first.receipt });
    expect(h.calls).toHaveLength(3);
  } finally { await h.close(); }
});

it("tombstones an interrupted dispatched build and never runs the same effect again", async () => {
  const h = await fixture();
  const controller = new AbortController();
  let started!: () => void;
  const dispatched = new Promise<void>(resolve => { started = resolve; });
  try {
    h.setBuild(async input => {
      h.calls.push("dispatched-build");
      started();
      return await new Promise<never>((_resolve, reject) => {
        input.signal?.addEventListener("abort", () => reject(new SimulatorProjectBuildError(
          "BUILD_OUTCOME_UNKNOWN", "Simulator build process outcome is unknown.")), { once: true });
      });
    });
    const pending = h.coordinator.execute(SCOPE, route(h.instance), {}, authority("7"), controller.signal);
    await dispatched;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "BUILD_OUTCOME_UNKNOWN" });
    await expect(h.coordinator.execute(SCOPE, route(h.instance), {}, authority("7")))
      .rejects.toMatchObject({ code: "BUILD_OUTCOME_UNKNOWN" });
    expect(h.calls).toEqual(["dispatched-build"]);
  } finally { await h.close(); }
});

it("keeps diagnostics accessible when the copied app fails final verification", async () => {
  const h = await fixture();
  try {
    const coordinator = new SimulatorProjectBuildCoordinator(h.store, h.ownership, {
      ...h.options, inspectArtifact: async () => {
        throw new SimulatorAppArtifactError("APP_ARTIFACT_INVALID", "Invalid app bundle.");
      }
    });
    let diagnosticsId = "";
    try { await coordinator.execute(SCOPE, route(h.instance), {}, authority("8")); }
    catch (error) {
      expect(error).toMatchObject({ code: "APP_ARTIFACT_INVALID",
        diagnostics: { diagnosticsId: expect.any(String) } });
      diagnosticsId = (error as { diagnostics: { diagnosticsId: string } }).diagnostics.diagnosticsId;
    }
    expect(await coordinator.readDiagnostics(SCOPE, diagnosticsId, "build-log"))
      .toMatchObject({ available: true, text: expect.stringContaining("BUILD SUCCEEDED") });
  } finally { await h.close(); }
});

it("rechecks a retained artifact before handing it to an install operation", async () => {
  const h = await fixture();
  try {
    const built = await h.coordinator.execute(SCOPE, route(h.instance), {}, authority("9"));
    const changed = new SimulatorProjectBuildCoordinator(h.store, h.ownership, {
      ...h.options, inspectArtifact: async ({ appPath }) => ({ appPath,
        bundleId: "app.joko.changed", executable: "Example" })
    });
    await expect(changed.getArtifact(SCOPE, route(h.instance), built.receipt.artifact.artifactId))
      .rejects.toMatchObject({ code: "APP_ARTIFACT_INVALID" });
    await rm(join(h.root, "managed", "artifacts", built.receipt.artifact.artifactId),
      { recursive: true, force: true });
    await expect(h.coordinator.getArtifact(SCOPE, route(h.instance), built.receipt.artifact.artifactId))
      .rejects.toMatchObject({ code: "APP_ARTIFACT_INVALID" });
  } finally { await h.close(); }
});

it("reclaims only aged unpublished private build storage after a host restart", async () => {
  const h = await fixture();
  try {
    const built = await h.coordinator.execute(SCOPE, route(h.instance), {}, authority("1"));
    const buildsRoot = join(h.root, "managed", "builds");
    const copiesRoot = join(h.root, "managed", "artifacts");
    const staleBuild = randomUUID();
    const freshBuild = randomUUID();
    const unpublishedCopy = randomUUID();
    await mkdir(join(buildsRoot, staleBuild));
    await mkdir(join(buildsRoot, freshBuild));
    await mkdir(join(copiesRoot, unpublishedCopy));
    const old = new Date(Date.now() - 2 * 24 * 60 * 60_000);
    await utimes(join(buildsRoot, staleBuild), old, old);
    await utimes(join(copiesRoot, unpublishedCopy), old, old);
    await utimes(join(copiesRoot, built.receipt.artifact.artifactId), old, old);
    await h.coordinator.reconcileBuildStorage();
    expect(await readdir(buildsRoot)).toContain(freshBuild);
    expect(await readdir(buildsRoot)).not.toContain(staleBuild);
    expect(await readdir(copiesRoot)).toContain(built.receipt.artifact.artifactId);
    expect(await readdir(copiesRoot)).not.toContain(unpublishedCopy);
  } finally { await h.close(); }
});
