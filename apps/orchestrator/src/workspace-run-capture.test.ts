import { access, readFile, rm, writeFile } from "node:fs/promises";
import { mkdtemp } from "./test-paths.js";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { BackendDescriptor, SessionDescriptor, TargetDescriptor } from "@joko/core";
import { OperationalStore } from "@joko/store";
import { afterEach, describe, expect, it, vi } from "vitest";

import { OperationalWorkspaceSnapshotRepository } from "./operational-workspace-snapshots.js";
import { WorkspaceChangeSetService } from "./workspace-change-set.js";
import { DurableWorkspaceRunCapture, prepareRunProjectGit } from "./workspace-run-capture.js";

const cleanupPaths: string[] = [];
const cleanupStores = new Set<OperationalStore>();

afterEach(async () => {
  for (const store of cleanupStores) store.close();
  cleanupStores.clear();
  for (const path of cleanupPaths.splice(0).reverse()) await rm(path, { recursive: true, force: true });
});

describe("DurableWorkspaceRunCapture", () => {
  it("keeps first-Run Git bootstrap inside the exact ordinary local project authority", async () => {
    const f = await outputFixture();
    const input = { sessionId: f.input.sessionId, runId: f.input.runId, workspaceRoot: f.workspace };
    const ensure = vi.fn(async ({ assertCurrent }: { readonly assertCurrent: () => void }) => {
      assertCurrent(); return { status: "skipped" as const, reason: "non_empty_project" as const };
    });
    await prepareRunProjectGit(f.store, { ensure }, input);
    expect(ensure).not.toHaveBeenCalled();
    const target = { ...f.input.target, managed: false };
    f.store.upsertTarget(target);
    await prepareRunProjectGit(f.store, { ensure }, input);
    expect(ensure).toHaveBeenCalledOnce();
    const remote = { kind: "ssh" as const, hostTargetId: "ssh-owner", hostId: "ssh-host", workspaceRoot: "/project" };
    f.store.upsertTarget({ ...target, id: "ssh-owner" });
    f.store.upsertTarget({ ...target, remoteWorkspace: remote });
    await prepareRunProjectGit(f.store, { ensure }, input);
    expect(ensure).toHaveBeenCalledOnce();
    f.store.upsertTarget(target);
    const session = f.store.getSession(f.input.sessionId).descriptor;
    const isolated = f.store.createSession({ ...session, id: "isolated-session", binding: { opaqueRef: "fake://isolated", generation: 1 },
      worktree: { leaseId: "isolation-lease", workspaceId: "isolated-workspace",
      path: f.workspace, repositoryRoot: f.workspace, branch: "isolated-fixture", sourceRef: "HEAD", sourceCommit: "a".repeat(40),
      sourceStrategy: "explicit", sourceRefreshed: false, state: "active", acquiredAt: 1, updatedAt: 1 } });
    f.store.createRun({ id: "isolated-run", sessionId: isolated.descriptor.id, source: "user", state: "running", createdAt: 1 });
    await prepareRunProjectGit(f.store, { ensure }, { ...input, sessionId: isolated.descriptor.id, runId: "isolated-run" });
    expect(ensure).toHaveBeenCalledOnce();
  });

  it("fences a first-Run Git bootstrap when its Target revision changes", async () => {
    const f = await outputFixture();
    f.store.upsertTarget({ ...f.input.target, managed: false });
    const ensure = vi.fn(async ({ assertCurrent }: { readonly assertCurrent: () => void }) => {
      const target = f.store.getTarget(f.input.target.id);
      f.store.upsertTarget({ ...target.descriptor, displayName: "Changed" });
      assertCurrent(); return { status: "skipped" as const, reason: "non_empty_project" as const };
    });
    await expect(prepareRunProjectGit(f.store, { ensure }, { sessionId: f.input.sessionId, runId: f.input.runId,
      workspaceRoot: f.workspace })).rejects.toThrow(/authority changed/iu);
  });

  it("keeps terminal output pending until the exact accepted capture and event commit together", async () => {
    const f = await outputFixture();
    await f.capture.captureBeforeRun(f.input); f.accept();
    await writeFile(join(f.workspace, "report.txt"), "result"); f.finish();
    let release!: () => void; const capture = f.service.captureChangeSet.bind(f.service);
    vi.spyOn(f.service, "captureChangeSet").mockImplementationOnce(async (...args) => {
      await new Promise<void>(resolve => { release = resolve; }); return capture(...args);
    });
    const observed: unknown[] = [];
    const unsubscribe = f.store.subscribe(event => {
      if (event.payload.type === "workspace_diff") observed.push(f.store.getSetting("session", f.input.sessionId, "workspace_output_seal.run-one").value);
    });
    const first = f.capture.captureAfterRun(f.input), joined = f.capture.captureAfterRun(f.input);
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    expect(f.store.getRun("run-one").descriptor.state).toBe("completed");
    expect(await f.capture.readRunOutput(f.input.sessionId, "run-one")).toEqual({ readiness: "pending", changes: [] });
    release(); await first; await joined;
    expect(f.service.captureChangeSet).toHaveBeenCalledOnce();
    expect(observed).toMatchObject([{ state: "ready", queueItemId: "queue-one" }]);
    expect(await f.capture.readRunOutput(f.input.sessionId, "run-one")).toEqual({ readiness: "ready", changes: [{ path: "report.txt", status: "added" }] });
    unsubscribe();
  });

  it("distinguishes a sealed valid empty result from missing, failed and incomplete captures", async () => {
    const empty = await outputFixture(); await empty.capture.captureBeforeRun(empty.input); empty.accept(); empty.finish();
    await empty.capture.captureAfterRun(empty.input);
    expect(await empty.capture.readRunOutput(empty.input.sessionId, "run-one")).toEqual({ readiness: "ready", changes: [] });
    const missing = await outputFixture(); missing.accept(); missing.finish(); await missing.capture.captureAfterRun(missing.input);
    expect(await missing.capture.readRunOutput(missing.input.sessionId, "run-one")).toEqual({ readiness: "unavailable", changes: [] });
    const failed = await outputFixture(); await failed.capture.captureBeforeRun(failed.input); failed.accept(); failed.finish();
    vi.spyOn(failed.service, "captureChangeSet").mockRejectedValueOnce(new Error("Capture failed"));
    await expect(failed.capture.captureAfterRun(failed.input)).rejects.toThrow("Capture failed");
    expect((await failed.capture.readRunOutput(failed.input.sessionId, "run-one")).readiness).toBe("unavailable");
    const incomplete = await outputFixture(1); await incomplete.capture.captureBeforeRun(incomplete.input); incomplete.accept();
    await writeFile(join(incomplete.workspace, "large.txt"), "larger than snapshot budget");
    await writeFile(join(incomplete.workspace, "partial.txt"), "x"); incomplete.finish(); await incomplete.capture.captureAfterRun(incomplete.input);
    expect(await incomplete.capture.readRunOutput(incomplete.input.sessionId, "run-one")).toEqual({ readiness: "unavailable", changes: [{ path: "partial.txt", status: "added" }] });
  });

  it("requires exact accepted Queue and Run anchors rather than only a terminal state", async () => {
    const f = await outputFixture(); await f.capture.captureBeforeRun(f.input);
    await writeFile(join(f.workspace, "unaccepted.txt"), "not accepted"); f.finish(); await f.capture.captureAfterRun(f.input);
    expect((await f.capture.readRunOutput(f.input.sessionId, "run-one")).readiness).toBe("unavailable");
    f.store.setSetting("session", f.input.sessionId, "workspace_output_seal.run-one", { version: 1,
      sessionId: "different-session", runId: "run-one", state: "ready", queueItemId: "queue-one", changeSetId: "wrong" });
    await expect(f.capture.readRunOutput(f.input.sessionId, "run-one")).rejects.toThrow("seal is unavailable");
  });

  it("reads sealed output after restart without scanning or overwriting ready on a late failure", async () => {
    const f = await outputFixture(); await f.capture.captureBeforeRun(f.input); f.accept();
    await writeFile(join(f.workspace, "saved.txt"), "saved"); f.finish(); await f.capture.captureAfterRun(f.input);
    f.store.close(); cleanupStores.delete(f.store);
    const restarted = new OperationalStore(join(f.data, "orchestrator.db")); cleanupStores.add(restarted);
    const reloaded = new WorkspaceChangeSetService({ snapshotDirectory: join(f.data, "snapshots"), repository: new OperationalWorkspaceSnapshotRepository(restarted) }); await reloaded.initialize();
    const capture = new DurableWorkspaceRunCapture(restarted, reloaded);
    vi.spyOn(reloaded, "captureBaseline").mockRejectedValue(new Error("No new scan"));
    vi.spyOn(reloaded, "captureChangeSet").mockRejectedValue(new Error("No new capture"));
    expect(await capture.readRunOutput(f.input.sessionId, "run-one")).toEqual({ readiness: "ready", changes: [{ path: "saved.txt", status: "added" }] });
    await capture.captureAfterRun(f.input);
    restarted.deleteSetting("session", f.input.sessionId, "workspace_capture.run-one");
    await expect(capture.captureBeforeRun(f.input)).rejects.toThrow("No new scan");
    expect(restarted.getSetting<{ state: string }>("session", f.input.sessionId, "workspace_output_seal.run-one").value.state).toBe("ready");
    expect(reloaded.captureChangeSet).not.toHaveBeenCalled();
  });

  it("captures a run change set, projects it, and restores only after a safe preview", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "joko-run-workspace-"));
    const data = await mkdtemp(join(tmpdir(), "joko-run-capture-"));
    cleanupPaths.push(workspace, data);
    const file = join(workspace, "value.txt");
    await writeFile(file, "before\n");
    const store = new OperationalStore(join(data, "orchestrator.db"));
    cleanupStores.add(store);
    const target: TargetDescriptor = {
      id: "target-one",
      backendId: "fake",
      displayName: "Workspace",
      workspaceRoot: workspace,
      managed: true,
      trusted: true
    };
    const backend: BackendDescriptor = {
      id: "fake",
      displayName: "Fake",
      version: "1.0.0",
      health: "healthy",
      adapterKind: "fixture",
      instanceGeneration: 0,
      installationState: "installed",
      authenticationState: "authenticated",
      capabilities: new Map(),
      models: [],
      tools: [],
      diagnostics: []
    };
    const now = Date.now();
    const session: SessionDescriptor = {
      id: "session-one",
      backendId: backend.id,
      targetId: target.id,
      title: "Task",
      binding: { opaqueRef: "fake://session-one", generation: 1 },
      pinned: false,
      archived: false,
      permissionMode: "ask",
      planMode: false,
      fastMode: false,
      createdAt: now,
      updatedAt: now
    };
    store.upsertBackend(backend);
    store.upsertTarget(target, { workspaceId: "workspace-one" });
    store.createSession(session);
    store.createRun({ id: "run-one", sessionId: session.id, source: "user", state: "running", createdAt: now });
    const service = new WorkspaceChangeSetService({
      snapshotDirectory: join(data, "snapshots"),
      repository: new OperationalWorkspaceSnapshotRepository(store)
    });
    await service.initialize();
    const capture = new DurableWorkspaceRunCapture(store, service);

    await capture.captureBeforeRun({ sessionId: session.id, runId: "run-one", target, navigationAnchor: { target: { kind: "session_start" }, generation: 1 } });
    await writeFile(file, "after\n");
    const created = join(workspace, "generated-report.txt");
    await writeFile(created, "new\n");
    await capture.captureAfterRun({ sessionId: session.id, runId: "run-one", target });
    await capture.captureAfterRun({ sessionId: session.id, runId: "run-one", target });

    const [changeSet] = await service.listChangeSets({ workspaceId: "workspace-one", sessionId: session.id });
    expect(changeSet?.dialogueAnchor).toEqual({ target: { kind: "session_start" }, generation: 1 });
    const reloaded = new WorkspaceChangeSetService({ snapshotDirectory: join(data, "snapshots"), repository: new OperationalWorkspaceSnapshotRepository(store) });
    await reloaded.initialize();
    expect((await reloaded.listChangeSets({ workspaceId: "workspace-one", sessionId: session.id }))[0]?.dialogueAnchor)
      .toEqual({ target: { kind: "session_start" }, generation: 1 });
    expect(changeSet?.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "value.txt", kind: "updated" }),
      expect.objectContaining({ path: "generated-report.txt", kind: "created" })
    ]));
    const diffEvent = store.listEvents({ sessionId: session.id }).find((event) => event.payload.type === "workspace_diff");
    expect(store.listEvents({ sessionId: session.id }).filter((event) => event.payload.type === "workspace_diff")).toHaveLength(1);
    expect(diffEvent?.payload).toMatchObject({
      type: "workspace_diff",
      changeSet: {
        completeBaseline: true,
        changes: expect.arrayContaining([
          expect.objectContaining({ relativePath: "generated-report.txt", kind: "created", afterRevision: expect.any(Object) }),
          expect.objectContaining({ relativePath: "value.txt", kind: "updated" })
        ])
      }
    });
    const preview = await service.previewRewind(changeSet!.id);
    expect(preview.safe).toBe(true);
    await service.applyRewind(preview.id);
    expect(await readFile(file, "utf8")).toBe("before\n");
    await expect(access(created)).rejects.toMatchObject({ code: "ENOENT" });
    store.close();
    cleanupStores.delete(store);
  });
});

async function outputFixture(maximumFileBytes?: number) {
  const workspace = await mkdtemp(join(tmpdir(), "joko-output-workspace-")), data = await mkdtemp(join(tmpdir(), "joko-output-capture-"));
  cleanupPaths.push(workspace, data);
  const store = new OperationalStore(join(data, "orchestrator.db")); cleanupStores.add(store);
  const target: TargetDescriptor = { id: "target-one", backendId: "fake", displayName: "Workspace", workspaceRoot: workspace, managed: true, trusted: true };
  const backend: BackendDescriptor = { id: "fake", displayName: "Fake", version: "1.0.0", health: "healthy", adapterKind: "fixture", instanceGeneration: 0,
    installationState: "installed", authenticationState: "authenticated", capabilities: new Map(), models: [], tools: [], diagnostics: [] };
  const now = Date.now();
  const session: SessionDescriptor = { id: "session-one", backendId: "fake", targetId: target.id, title: "Output", binding: { opaqueRef: "fake://session-one", generation: 1 },
    pinned: false, archived: false, permissionMode: "ask", planMode: false, fastMode: false, createdAt: now, updatedAt: now };
  store.upsertBackend(backend); store.upsertTarget(target, { workspaceId: "workspace-one" }); store.createSession(session);
  store.createRun({ id: "run-one", sessionId: session.id, source: "system", state: "queued", createdAt: now });
  store.createAttempt({ id: "attempt-one", runId: "run-one", ordinal: 1, generation: 1, startedAt: now });
  const prompt = { text: "Produce output", images: [], files: [], mentions: [], disposition: "prompt" as const };
  store.runOperation({ id: "output-input", kind: "service_send_input", body: { sessionId: session.id, prompt } }, transaction => {
    transaction.enqueueQueueItem({ id: "queue-one", sessionId: session.id, runId: "run-one", attemptId: "attempt-one", operationId: "output-input", disposition: "prompt", body: prompt }); return {};
  });
  store.claimNextQueueItem({ sessionId: session.id, backendInstanceGeneration: 0, traceId: "dispatch" });
  store.updateRunState({ runId: "run-one", state: "running", activeAttemptId: "attempt-one", traceId: "running" });
  const repository = new OperationalWorkspaceSnapshotRepository(store);
  const service = new WorkspaceChangeSetService({ snapshotDirectory: join(data, "snapshots"), repository,
    ...(maximumFileBytes === undefined ? {} : { maximumFileBytes }) }); await service.initialize();
  const capture = new DurableWorkspaceRunCapture(store, service);
  return { workspace, data, store, repository, service, capture, input: { sessionId: session.id, runId: "run-one", target },
    accept() { store.updateQueueState({ queueItemId: "queue-one", state: "backend_accepted", attemptId: "attempt-one", traceId: "accepted" }); },
    finish() { store.updateRunState({ runId: "run-one", state: "completed", traceId: "completed" }); } };
}
