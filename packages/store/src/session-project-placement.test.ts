import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { OperationalStore, RevisionConflictError } from "./index.js";

const cleanup: Array<() => void> = [];

afterEach(() => {
  for (const dispose of cleanup.splice(0).reverse()) dispose();
});

describe("Session project placement", () => {
  it("defaults new Sessions to their runtime Target project", () => {
    const store = fixture();
    const session = store.getSession("session-a");
    expect(session.descriptor.projectId).toBe("target-runtime");
  });

  it("moves only navigation placement and persists an event before returning", () => {
    const store = fixture();
    const before = store.getSession("session-a");
    const moved = store.moveSessionProject({
      sessionId: before.descriptor.id,
      expectedRevision: before.revision,
      projectId: "target-project",
      movedAt: 8
    });

    expect(moved.descriptor).toMatchObject({
      projectId: "target-project",
      targetId: "target-runtime",
      backendId: "backend-a",
      binding: { opaqueRef: "native/session-a", generation: 3 },
      updatedAt: 8
    });
    expect(store.getSession("session-a").descriptor.projectId).toBe("target-project");
    expect(store.listEvents({ sessionId: "session-a", limit: 100 }).at(-1)?.payload)
      .toEqual({ type: "session_changed" });
  });

  it("supports Dialogue placement, exact revision fences, and no-op stability", () => {
    const store = fixture();
    const initial = store.getSession("session-a");
    const dialogue = store.moveSessionProject({
      sessionId: initial.descriptor.id,
      expectedRevision: initial.revision
    });
    expect(dialogue.descriptor.projectId).toBeUndefined();

    const unchanged = store.moveSessionProject({
      sessionId: dialogue.descriptor.id,
      expectedRevision: dialogue.revision
    });
    expect(unchanged.revision).toBe(dialogue.revision);

    expect(() => store.moveSessionProject({
      sessionId: dialogue.descriptor.id,
      expectedRevision: initial.revision,
      projectId: "target-project"
    })).toThrow(RevisionConflictError);
  });
});

function fixture(): OperationalStore {
  const directory = mkdtempSync(path.join(tmpdir(), "joko-placement-"));
  const store = new OperationalStore(path.join(directory, "operational.sqlite"));
  cleanup.push(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  store.upsertBackend({
    id: "backend-a",
    displayName: "Backend",
    version: "1",
    health: "healthy",
    adapterKind: "fixture",
    instanceGeneration: 0,
    installationState: "installed",
    authenticationState: "not_required",
    capabilities: new Map(),
    models: [],
    tools: [],
    diagnostics: []
  });
  for (const [id, workspaceRoot] of [
    ["target-runtime", "D:/runtime"],
    ["target-project", "D:/project"]
  ] as const) {
    store.upsertTarget({
      id,
      backendId: "backend-a",
      displayName: id,
      workspaceRoot,
      managed: false,
      trusted: true
    });
  }
  store.createSession({
    id: "session-a",
    backendId: "backend-a",
    targetId: "target-runtime",
    title: "Task",
    binding: { opaqueRef: "native/session-a", generation: 3 },
    pinned: false,
    archived: false,
    permissionMode: "ask",
    planMode: false,
    fastMode: false,
    createdAt: 1,
    updatedAt: 1
  });
  return store;
}
