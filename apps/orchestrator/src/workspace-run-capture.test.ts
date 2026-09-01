import { access, readFile, rm, writeFile } from "node:fs/promises";
import { mkdtemp } from "./test-paths.js";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { BackendDescriptor, SessionDescriptor, TargetDescriptor } from "@joko/core";
import { OperationalStore } from "@joko/store";
import { afterEach, describe, expect, it } from "vitest";

import { OperationalWorkspaceSnapshotRepository } from "./operational-workspace-snapshots.js";
import { WorkspaceChangeSetService } from "./workspace-change-set.js";
import { DurableWorkspaceRunCapture } from "./workspace-run-capture.js";

const cleanupPaths: string[] = [];
const cleanupStores = new Set<OperationalStore>();

afterEach(async () => {
  for (const store of cleanupStores) store.close();
  cleanupStores.clear();
  for (const path of cleanupPaths.splice(0).reverse()) await rm(path, { recursive: true, force: true });
});

describe("DurableWorkspaceRunCapture", () => {
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

    await capture.captureBeforeRun({ sessionId: session.id, runId: "run-one", target });
    await writeFile(file, "after\n");
    const created = join(workspace, "generated-report.txt");
    await writeFile(created, "new\n");
    await capture.captureAfterRun({ sessionId: session.id, runId: "run-one", target });
    await capture.captureAfterRun({ sessionId: session.id, runId: "run-one", target });

    const [changeSet] = await service.listChangeSets({ workspaceId: "workspace-one", sessionId: session.id });
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
