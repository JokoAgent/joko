import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { EventPayload, SessionDescriptor } from "@joko/core";
import { OperationalStore } from "@joko/store";
import { afterEach, describe, expect, it, vi } from "vitest";

import { HistoryMaintenance, type HistoryBindingReplacement } from "./history-maintenance.js";
import { cleanHistoryMaintenanceCopy, HistoryWorkCancelledError } from "./history-maintenance-worker.js";

const NOW = 1_000_000_000;
const OLD = 1_000;
const RECENT = NOW - 24 * 60 * 60_000;
const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

describe("HistoryMaintenance", () => {
  it("physically cleans frozen history, resets eligible active context, and retains files and task entries", async () => {
    const fixture = createFixture();
    createTask(fixture.store, "active-old", "active", OLD, visible("active private history"));
    createTask(fixture.store, "archived-old", "archived", OLD, visible("archived private history"));
    createTask(fixture.store, "deleted-old", "deleted", OLD, visible("deleted private history"));
    createTask(fixture.store, "archived-recent", "archived", RECENT, visible("recent retained history"));
    addTerminalTurn(fixture.store, "active-old");
    fixture.store.putObjective({ sessionId: "active-old", text: "private objective", updatedAt: OLD });
    fixture.store.putArtifact({
      id: "artifact-retained",
      sha256: "a".repeat(64),
      byteLength: 42,
      mimeType: "text/plain",
      fileName: "retained.txt",
      storageKey: "managed/retained.txt",
      sessionId: "active-old",
      runId: "run-active-old",
      metadata: { source: "test" },
      createdAt: OLD
    });

    const replacement: HistoryBindingReplacement = {
      sessionId: "active-old",
      source: fixture.store.getSession("active-old").descriptor.binding,
      replacement: {
        opaqueRef: "native/active-old-empty.jsonl",
        nativeSessionId: "native-active-old-empty",
        generation: 1
      }
    };
    const prepare = vi.fn(async () => [replacement]);
    const release = vi.fn();
    const removeSessionHistory = vi.fn(async () => undefined);
    const maintenance = new HistoryMaintenance({
      store: fixture.store,
      activeSessions: { prepare, release },
      externalRecords: { removeSessionHistory },
      now: () => NOW,
      workDatabase: async (input) => cleanHistoryMaintenanceCopy(input)
    });

    const scan = maintenance.scan({ retention: "7-days", includeActiveTasks: true });
    expect(scan).toMatchObject({
      activeTaskCount: 1,
      archivedTaskCount: 1,
      deletedTaskCount: 1,
      messageCount: 3
    });

    const outcome = await maintenance.cleanup(scan.scanId, true);
    expect(outcome).toMatchObject({
      outcome: "completed",
      result: {
        activeTaskCount: 1,
        archivedTaskCount: 1,
        deletedTaskCount: 1,
        messageCount: 3,
        backupCreated: true,
        skippedTaskCount: 0
      }
    });
    expect(prepare).toHaveBeenCalledWith(["active-old"]);
    expect(release).toHaveBeenCalledWith(["active-old"]);
    expect(release).toHaveBeenCalledTimes(1);
    expect(removeSessionHistory).toHaveBeenCalledWith(["active-old"]);
    expect(existsSync(`${fixture.filePath}.history-backup`)).toBe(true);

    expect(fixture.store.getSession("active-old").descriptor.binding).toEqual(replacement.replacement);
    expect(fixture.store.getSession("archived-old").descriptor.archived).toBe(true);
    expect(fixture.store.getSession("deleted-old").descriptor.deletedAt).toBeDefined();
    expect(fixture.store.getArtifact("artifact-retained")).toMatchObject({
      blob: { fileName: "retained.txt" },
      sessionId: "active-old"
    });
    expect(fixture.store.getArtifact("artifact-retained").runId).toBeUndefined();
    expect(fixture.store.findObjective("active-old")).toBeUndefined();
    expect(fixture.store.findOperation("operation-active-old")).toBeUndefined();
    expect(fixture.store.listQueueItems({ sessionId: "active-old" })).toEqual([]);
    expect(fixture.store.listRuns({ sessionId: "active-old", includeCleared: true })).toEqual([]);
    for (const sessionId of ["active-old", "archived-old", "deleted-old"]) {
      expect(fixture.store.searchSessionMessages({
        scope: { sessionId },
        query: "private history"
      }).matches).toEqual([]);
    }
    expect(fixture.store.searchSessionMessages({
      scope: { targetId: "target-1" },
      query: "recent retained history"
    }).matches).toHaveLength(1);

    for (const sessionId of ["active-old", "archived-old", "deleted-old"]) {
      expect(fixture.store.listEvents({ sessionId }).map((event) => event.payload)).toEqual([
        { type: "history_pruned", activeContextReset: sessionId === "active-old" }
      ]);
    }
    expect(fixture.store.listEvents({ sessionId: "archived-recent" }).map((event) => event.payload.type))
      .toContain("message_complete");

    const backup = new DatabaseSync(`${fixture.filePath}.history-backup`, { readOnly: true });
    try {
      expect(backup.prepare("SELECT COUNT(*) AS count FROM artifacts WHERE id = 'artifact-retained'").get())
        .toEqual({ count: 1 });
      expect(backup.prepare(
        "SELECT COUNT(*) AS count FROM events WHERE json_extract(payload_json, '$.payload.type') = 'message_complete'"
      ).get()).toEqual({ count: 4 });
    } finally {
      backup.close();
    }
  });

  it("skips a task whose status or native binding changed after the scan", async () => {
    const fixture = createFixture();
    createTask(fixture.store, "archived-old", "archived", OLD, visible("keep after change"));
    const maintenance = new HistoryMaintenance({
      store: fixture.store,
      activeSessions: { prepare: async () => [], release: () => undefined },
      now: () => NOW,
      workDatabase: async (input) => cleanHistoryMaintenanceCopy(input)
    });
    const scan = maintenance.scan({ retention: "7-days", includeActiveTasks: false });
    const session = fixture.store.getSession("archived-old");
    fixture.store.updateSession("archived-old", { archived: false }, session.revision, NOW);

    const outcome = await maintenance.cleanup(scan.scanId, false);
    expect(outcome).toMatchObject({
      outcome: "completed",
      result: { messageCount: 0, skippedTaskCount: 1, backupCreated: false }
    });
    expect(fixture.store.searchSessionMessages({
      scope: { sessionId: "archived-old" },
      query: "keep after change"
    }).matches).toHaveLength(1);
  });

  it("does not report a committed cleanup as failed when external cache reconciliation fails", async () => {
    const fixture = createFixture();
    createTask(fixture.store, "active-old", "active", OLD, visible("history to clear"));
    const source = fixture.store.getSession("active-old").descriptor.binding;
    const maintenance = new HistoryMaintenance({
      store: fixture.store,
      activeSessions: {
        prepare: async () => [{
          sessionId: "active-old",
          source,
          replacement: { opaqueRef: "native/empty.jsonl", generation: 1 }
        }],
        release: () => undefined
      },
      externalRecords: { removeSessionHistory: async () => { throw new Error("cache unavailable"); } },
      now: () => NOW,
      workDatabase: async (input) => cleanHistoryMaintenanceCopy(input)
    });

    const scan = maintenance.scan({ retention: "7-days", includeActiveTasks: true });
    await expect(maintenance.cleanup(scan.scanId, false)).resolves.toMatchObject({ outcome: "completed" });
    expect(fixture.store.listEvents({ sessionId: "active-old" }).map((event) => event.payload.type))
      .toEqual(["history_pruned"]);
  });

  it("reports background progress and cancels before replacement without changing the source database", async () => {
    const fixture = createFixture();
    createTask(fixture.store, "archived-old", "archived", OLD, visible("history survives cancellation"));
    const maintenance = new HistoryMaintenance({
      store: fixture.store,
      activeSessions: { prepare: async () => [], release: () => undefined },
      now: () => NOW,
      workDatabase: async (_input, controls) => {
        controls?.onProgress?.("cleaning", 40);
        await new Promise<void>((_resolve, reject) => {
          if (controls?.signal?.aborted === true) {
            reject(new HistoryWorkCancelledError());
            return;
          }
          controls?.signal?.addEventListener("abort", () => reject(new HistoryWorkCancelledError()), { once: true });
        });
        throw new Error("unreachable");
      }
    });
    const scan = maintenance.scan({ retention: "7-days", includeActiveTasks: false });
    const started = maintenance.beginCleanup(scan.scanId, true);
    await vi.waitFor(() => expect(maintenance.getCleanup(started.maintenanceId)).toMatchObject({
      status: "running",
      phase: "cleaning",
      percent: 40,
      cancellable: true
    }));

    maintenance.cancelCleanup(started.maintenanceId);
    await vi.waitFor(() => expect(maintenance.getCleanup(started.maintenanceId)?.status).toBe("cancelled"));
    expect(fixture.store.searchSessionMessages({
      scope: { sessionId: "archived-old" },
      query: "survives cancellation"
    }).matches).toHaveLength(1);
    expect(fixture.store.listEvents({ sessionId: "archived-old" }).some((event) => event.payload.type === "history_pruned"))
      .toBe(false);
    expect(existsSync(`${fixture.filePath}.history-backup`)).toBe(false);
  });
});

function createFixture(): { readonly store: OperationalStore; readonly filePath: string } {
  const directory = mkdtempSync(path.join(tmpdir(), "joko-history-maintenance-"));
  const filePath = path.join(directory, "operational.sqlite");
  let nextId = 0;
  const store = new OperationalStore(filePath, { now: () => OLD, idFactory: () => `generated-${++nextId}` });
  store.upsertBackend({
    id: "runtime",
    displayName: "Runtime",
    version: "test",
    health: "healthy",
    adapterKind: "fixture",
    instanceGeneration: 0,
    installationState: "installed",
    authenticationState: "authenticated",
    capabilities: new Map(),
    models: [],
    tools: [],
    diagnostics: []
  });
  store.upsertTarget({
    id: "target-1",
    backendId: "runtime",
    displayName: "Workspace",
    workspaceRoot: "D:/workspace",
    managed: false,
    trusted: true
  });
  cleanups.push(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { store, filePath };
}

function createTask(
  store: OperationalStore,
  id: string,
  status: "active" | "archived" | "deleted",
  updatedAt: number,
  payload: EventPayload
): void {
  const descriptor: SessionDescriptor = {
    id,
    backendId: "runtime",
    targetId: "target-1",
    title: id,
    binding: { opaqueRef: `native/${id}.jsonl`, nativeSessionId: `native-${id}`, generation: 0 },
    pinned: false,
    archived: false,
    permissionMode: "ask",
    planMode: false,
    fastMode: false,
    createdAt: updatedAt,
    updatedAt
  };
  store.createSession(descriptor);
  store.appendEvent({
    id: `message-${id}`,
    backendId: descriptor.backendId,
    targetId: descriptor.targetId,
    sessionId: id,
    generation: 0,
    emittedAt: updatedAt,
    traceId: `test:${id}`,
    payload
  });
  if (status === "archived") {
    const session = store.getSession(id);
    store.updateSession(id, { archived: true }, session.revision, updatedAt);
  }
  if (status === "deleted") {
    const session = store.getSession(id);
    store.updateSession(id, { deletedAt: updatedAt }, session.revision, updatedAt);
  }
}

function visible(text: string): EventPayload {
  return { type: "message_complete", role: "assistant", blocks: [{ kind: "text", text }] };
}

function addTerminalTurn(store: OperationalStore, sessionId: string): void {
  const runId = `run-${sessionId}`;
  const attemptId = `attempt-${sessionId}`;
  const queueItemId = `queue-${sessionId}`;
  const operationId = `operation-${sessionId}`;
  store.createRun({
    id: runId,
    sessionId,
    source: "user",
    state: "completed",
    createdAt: OLD,
    endedAt: OLD + 1
  });
  store.createAttempt({
    id: attemptId,
    runId,
    ordinal: 1,
    generation: store.getSession(sessionId).descriptor.binding.generation,
    startedAt: OLD
  });
  store.runOperation({ id: operationId, kind: "prompt", body: { sessionId, text: "private queued prompt" } }, (target) => {
    target.enqueueQueueItem({
      id: queueItemId,
      sessionId,
      runId,
      attemptId,
      operationId,
      disposition: "prompt",
      body: { text: "private queued prompt", images: [], files: [], mentions: [], disposition: "prompt" },
      createdAt: OLD
    });
    return { accepted: true };
  });
  const backendInstanceGeneration = store.getBackend(store.getSession(sessionId).descriptor.backendId)
    .descriptor.instanceGeneration;
  store.claimNextQueueItem({ sessionId, backendInstanceGeneration, at: OLD + 1 });
  for (const state of ["backend_accepted", "completed"] as const) {
    store.updateQueueState({ queueItemId, state, attemptId, traceId: `test:${queueItemId}:${state}`, at: OLD + 1 });
  }
}
