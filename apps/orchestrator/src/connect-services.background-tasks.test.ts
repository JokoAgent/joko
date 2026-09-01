import { rmSync } from "node:fs";
import { mkdtempSync } from "./test-paths.js";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { Code } from "@connectrpc/connect";
import * as contract from "@joko/contracts";
import { OperationalStore } from "@joko/store";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { OrchestratorApplication } from "./application.js";
import { createConnectServices } from "./connect-services.js";
import { fromProtoTimestamp } from "./proto-mapper.js";

const disposals: Array<() => void> = [];

afterEach(() => {
  for (const dispose of disposals.splice(0).reverse()) dispose();
});

describe("durable background task history", () => {
  it("merges durable observations, preserves optional facts, sorts deterministically, pages, filters, and round-trips", async () => {
    const fixture = createFixture(true);
    append(fixture.store, "active-older", 100, {
      state: "queued",
      title: "Older active task",
      parentTaskId: "batch-a"
    });
    append(fixture.store, "done-older", 120, {
      state: "running",
      title: "Older finished task",
      parentTaskId: "batch-b",
      progressRatio: 0.7,
      startedAt: 150
    });
    append(fixture.store, "active-newer", 200, {
      state: "running",
      title: "Newer active task",
      startedAt: 300
    });
    append(fixture.store, "done-newer", 250, {
      state: "running",
      title: "Newer finished task",
      startedAt: 260
    });
    append(fixture.store, "active-older", 500, {
      state: "running",
      title: "Older active task",
      detail: "Indexing",
      progressRatio: 0.25,
      startedAt: 180
    });
    append(fixture.store, "done-older", 800, {
      state: "failed",
      title: "Older finished task",
      endedAt: 700,
      error: {
        code: "TASK_FAILED",
        phase: "background_task",
        message: "The delegated task stopped safely.",
        retryable: true,
        stateMayHaveChanged: false,
        recovery: "Retry the task."
      }
    });
    append(fixture.store, "done-newer", 900, {
      state: "completed",
      title: "Newer finished task",
      endedAt: 850
    });
    fixture.store.createSession({
      id: "session-b",
      backendId: "task-backend",
      targetId: "target-a",
      title: "Other Session",
      binding: { opaqueRef: "native:session-b", generation: 1 },
      pinned: false,
      archived: false,
      permissionMode: "ask",
      planMode: false,
      fastMode: false,
      createdAt: 1,
      updatedAt: 1
    });
    fixture.store.appendEvent({
      emittedAt: 950,
      backendId: "task-backend",
      targetId: "target-a",
      sessionId: "session-b",
      generation: 1,
      traceId: "background:other-session",
      payload: {
        type: "background_task",
        taskId: "other-session-task",
        title: "Other Session task",
        state: "running"
      }
    });

    fixture.store.close();
    const reopened = fixture.reopen();
    const services = createConnectServices(application(reopened));
    const firstRequest = create(contract.ListBackgroundTasksRequestSchema, {
      sessionId: "session-a",
      page: create(contract.PageRequestSchema, { pageSize: 2 })
    });
    const first = await invoke<contract.ListBackgroundTasksResponse>(
      services.session.listBackgroundTasks,
      firstRequest
    );

    expect(first.backgroundTasks.map((task) => task.backgroundTaskId)).toEqual([
      "active-older",
      "active-newer"
    ]);
    expect(first.page).toMatchObject({ totalSize: 4n });
    expect(first.page?.nextPageToken).not.toBe("");
    expect(first.backgroundTasks[0]).toMatchObject({
      parentTaskId: "batch-a",
      progressRatio: 0.25,
      statusText: "Indexing",
      state: contract.BackgroundTaskState.RUNNING
    });
    expect(fromProtoTimestamp(first.backgroundTasks[0]?.createdAt)).toBe(100);
    expect(fromProtoTimestamp(first.backgroundTasks[0]?.updatedAt)).toBe(500);
    expect(fromProtoTimestamp(first.backgroundTasks[0]?.startedAt)).toBe(180);
    expect(first.backgroundTasks[1]?.progressRatio).toBeUndefined();

    const second = await invoke<contract.ListBackgroundTasksResponse>(
      services.session.listBackgroundTasks,
      create(contract.ListBackgroundTasksRequestSchema, {
        sessionId: "session-a",
        page: create(contract.PageRequestSchema, { pageSize: 2, pageToken: first.page?.nextPageToken })
      })
    );
    expect(second.backgroundTasks.map((task) => task.backgroundTaskId)).toEqual([
      "done-newer",
      "done-older"
    ]);
    expect(second.page).toMatchObject({ nextPageToken: "", totalSize: 4n });
    expect(second.backgroundTasks[0]?.progressRatio).toBeUndefined();
    expect(second.backgroundTasks[1]).toMatchObject({
      parentTaskId: "batch-b",
      progressRatio: 0.7,
      state: contract.BackgroundTaskState.FAILED,
      error: { code: "TASK_FAILED" }
    });
    expect(fromProtoTimestamp(second.backgroundTasks[1]?.startedAt)).toBe(150);
    expect(fromProtoTimestamp(second.backgroundTasks[1]?.endedAt)).toBe(700);

    const typedSecond = create(contract.ListBackgroundTasksResponseSchema, {
      backgroundTasks: second.backgroundTasks,
      page: second.page
    });
    const responseRoundTrip = fromBinary(
      contract.ListBackgroundTasksResponseSchema,
      toBinary(contract.ListBackgroundTasksResponseSchema, typedSecond)
    );
    expect(responseRoundTrip).toEqual(typedSecond);

    const failedRequest = create(contract.ListBackgroundTasksRequestSchema, {
      sessionId: "session-a",
      state: contract.BackgroundTaskState.FAILED
    });
    const requestRoundTrip = fromBinary(
      contract.ListBackgroundTasksRequestSchema,
      toBinary(contract.ListBackgroundTasksRequestSchema, failedRequest)
    );
    expect(requestRoundTrip.state).toBe(contract.BackgroundTaskState.FAILED);
    const failed = await invoke<contract.ListBackgroundTasksResponse>(
      services.session.listBackgroundTasks,
      requestRoundTrip
    );
    expect(failed.backgroundTasks.map((task) => task.backgroundTaskId)).toEqual(["done-older"]);
    expect(failed.page?.totalSize).toBe(1n);
  });

  it("authenticates first and gates the read on the Backend capability", async () => {
    const fixture = createFixture(false);
    const query = vi.spyOn(fixture.store, "listSessionBackgroundTaskEvents");
    const services = createConnectServices(application(fixture.store));
    const request = create(contract.ListBackgroundTasksRequestSchema, { sessionId: "session-a" });

    await expect(invoke(services.session.listBackgroundTasks, request, false))
      .rejects.toMatchObject({ code: Code.Unauthenticated });
    expect(query).not.toHaveBeenCalled();
    await expect(invoke(services.session.listBackgroundTasks, request))
      .rejects.toMatchObject({ code: Code.Unimplemented });
    expect(query).not.toHaveBeenCalled();
  });

  it("enforces canonical page tokens and the shared maximum page size", async () => {
    const fixture = createFixture(true);
    for (let index = 0; index < 501; index += 1) {
      append(fixture.store, `task-${index.toString().padStart(3, "0")}`, 1_000 + index, {
        state: "completed",
        title: `Task ${index}`,
        endedAt: 1_000 + index
      });
    }
    const services = createConnectServices(application(fixture.store));
    const first = await invoke<contract.ListBackgroundTasksResponse>(
      services.session.listBackgroundTasks,
      create(contract.ListBackgroundTasksRequestSchema, {
        sessionId: "session-a",
        page: create(contract.PageRequestSchema, { pageSize: 0xffff_ffff })
      })
    );
    expect(first.backgroundTasks).toHaveLength(500);
    expect(first.page?.totalSize).toBe(501n);
    expect(first.page?.nextPageToken).not.toBe("");

    const second = await invoke<contract.ListBackgroundTasksResponse>(
      services.session.listBackgroundTasks,
      create(contract.ListBackgroundTasksRequestSchema, {
        sessionId: "session-a",
        page: create(contract.PageRequestSchema, { pageSize: 1, pageToken: first.page?.nextPageToken })
      })
    );
    expect(second.backgroundTasks.map((task) => task.backgroundTaskId)).toEqual(["task-000"]);
    expect(second.page?.nextPageToken).toBe("");

    await expect(invoke(
      services.session.listBackgroundTasks,
      create(contract.ListBackgroundTasksRequestSchema, {
        sessionId: "session-a",
        page: create(contract.PageRequestSchema, { pageToken: "not-a-canonical-token" })
      })
    )).rejects.toMatchObject({ code: Code.InvalidArgument });
  });
});

type BackgroundPayload = Omit<
  Extract<import("@joko/core").EventPayload, { readonly type: "background_task" }>,
  "type" | "taskId"
>;

function append(
  store: OperationalStore,
  taskId: string,
  emittedAt: number,
  payload: BackgroundPayload
): void {
  store.appendEvent({
    emittedAt,
    backendId: "task-backend",
    targetId: "target-a",
    sessionId: "session-a",
    runId: "run-a",
    generation: 1,
    traceId: `background:${taskId}:${emittedAt}`,
    payload: { type: "background_task", taskId, ...payload }
  });
}

function createFixture(supported: boolean): {
  readonly store: OperationalStore;
  readonly reopen: () => OperationalStore;
} {
  const directory = mkdtempSync(join(tmpdir(), "joko-background-history-"));
  const database = join(directory, "operational.sqlite");
  let current: OperationalStore | undefined = new OperationalStore(database);
  const initialize = current;
  initialize.upsertBackend({
    id: "task-backend",
    displayName: "Task backend",
    version: "test",
    health: "healthy",
    adapterKind: "fixture",
    instanceGeneration: 0,
    installationState: "installed",
    authenticationState: "authenticated",
    capabilities: new Map([[contract.capabilityNames.backgroundTasks, supported
      ? { key: contract.capabilityNames.backgroundTasks, supported: true }
      : {
          key: contract.capabilityNames.backgroundTasks,
          supported: false,
          reason: "upstream_missing",
          detail: "Background task history is unavailable."
        }]]),
    models: [],
    tools: [],
    diagnostics: []
  });
  initialize.upsertTarget({
    id: "target-a",
    backendId: "task-backend",
    displayName: "Workspace",
    workspaceRoot: "D:/workspace",
    managed: false,
    trusted: true
  });
  initialize.createSession({
    id: "session-a",
    backendId: "task-backend",
    targetId: "target-a",
    title: "Session",
    binding: { opaqueRef: "native:session-a", generation: 1 },
    pinned: false,
    archived: false,
    permissionMode: "ask",
    planMode: false,
    fastMode: false,
    createdAt: 1,
    updatedAt: 1
  });
  initialize.createRun({
    id: "run-a",
    sessionId: "session-a",
    source: "user",
    state: "running",
    createdAt: 2
  });
  disposals.push(() => {
    try { current?.close(); } catch { /* Already closed by the durability assertion. */ }
    current = undefined;
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    store: initialize,
    reopen: () => {
      current = new OperationalStore(database);
      return current;
    }
  };
}

function application(store: OperationalStore): OrchestratorApplication {
  return {
    config: { publicOrigin: "https://orchestrator.example.test" },
    store,
    connections: {
      authenticate: (authorization?: string) => {
        if (authorization !== "Bearer background-history-test") {
          throw new Error("Authentication required.");
        }
        return { id: "connection-a" };
      }
    },
    artifacts: {},
    blobTransfers: {},
    artifactRepository: {},
    workspaces: {},
    workspaceChanges: {},
    sessionHost: {},
    scheduler: {},
    adapters: [],
    browserActivity: [],
    close: async () => undefined
  } as unknown as OrchestratorApplication;
}

async function invoke<T>(handler: unknown, request: unknown, authenticated = true): Promise<T> {
  if (typeof handler !== "function") throw new Error("RPC handler is missing.");
  return await (handler as (request: unknown, context: unknown) => Promise<T> | T)(request, {
    requestHeader: authenticated
      ? new Headers({ authorization: "Bearer background-history-test" })
      : new Headers(),
    signal: new AbortController().signal
  });
}
