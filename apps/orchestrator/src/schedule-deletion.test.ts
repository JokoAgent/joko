import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "./test-paths.js";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { create } from "@bufbuild/protobuf";
import * as contract from "@joko/contracts";
import {
  OperationalStore,
  type ConnectionRecord,
  type OperationExecution
} from "@joko/store";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { OrchestratorApplication } from "./application.js";
import { createConnectServices } from "./connect-services.js";
import type { SessionHost } from "./session-host.js";

const cleanups: Array<() => void> = [];

afterEach(() => {
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

describe("durable Schedule deletion", () => {
  it("installs every startup deletion fence before awaiting any cleanup", async () => {
    const fixture = createFixture();
    const secondScheduleId = "schedule-generated-second";
    fixture.store.upsertSchedule({
      id: secondScheduleId,
      backendId: "backend",
      targetId: "target",
      sessionMode: "fresh",
      name: "Second generated task",
      kind: "manual",
      timezone: "UTC",
      enabled: true,
      prompt: { text: "run second", images: [], files: [], mentions: [], disposition: "prompt" },
      executionSnapshot: {},
      overlapPolicy: "queue",
      misfirePolicy: "run_once"
    });
    fixture.store.prepareScheduleDeletionCleanup({
      operationId: "startup-delete-first",
      scheduleId: fixture.scheduleId,
      disposition: "keep",
      occurrenceRunIds: [],
      at: 2
    });
    fixture.store.prepareScheduleDeletionCleanup({
      operationId: "startup-delete-second",
      scheduleId: secondScheduleId,
      disposition: "keep",
      occurrenceRunIds: [],
      at: 3
    });
    let releaseFirst!: () => void;
    const firstFence = new Promise<readonly string[]>((resolve) => {
      releaseFirst = () => resolve([]);
    });
    fixture.beginScheduleDeletion.mockImplementation(async (scheduleId) =>
      scheduleId === fixture.scheduleId ? firstFence : []
    );

    servicesFor(fixture, vi.fn(async () => undefined));

    expect(fixture.beginScheduleDeletion.mock.calls.map(([scheduleId]) => scheduleId)).toEqual([
      fixture.scheduleId,
      secondScheduleId
    ]);
    fixture.serviceCleanup();
    releaseFirst();
  });

  it("closes a generated task without a worktree before committing its tombstone", async () => {
    const fixture = createFixture();
    const order: string[] = [];
    const prepare = vi.fn(async (_sessionId: string) => { order.push("prepare"); });
    const close = vi.fn(async (_sessionId: string) => { order.push("close"); });
    const services = servicesFor(fixture, close, prepare);

    const response = await services.operation.submitOperation(deleteRequest(
      fixture.connection.id,
      "delete-generated-no-worktree",
      fixture.scheduleId
    ), context());

    expect(close).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledWith(fixture.generatedSessionId);
    expect(prepare).toHaveBeenCalledExactlyOnceWith(fixture.generatedSessionId);
    expect(order).toEqual(["prepare", "close"]);
    expect(fixture.store.getSession(fixture.generatedSessionId).descriptor.deletedAt).toBeDefined();
    expect(response.operation?.result?.payload).toMatchObject({
      case: "scheduleDeletion",
      value: {
        generatedSessionIds: [fixture.generatedSessionId],
        completedSessionIds: [fixture.generatedSessionId],
        failures: []
      }
    });
  });

  it("closes an already archived generated task before completing archive disposition", async () => {
    const fixture = createFixture();
    const current = fixture.store.getSession(fixture.generatedSessionId);
    fixture.store.updateSession(
      fixture.generatedSessionId,
      { archived: true },
      current.revision,
      2
    );
    const close = vi.fn(async () => undefined);
    const services = servicesFor(fixture, close);

    const response = await services.operation.submitOperation(deleteRequest(
      fixture.connection.id,
      "archive-already-archived-generated",
      fixture.scheduleId,
      contract.ScheduleGeneratedSessionDisposition.ARCHIVE
    ), context());

    expect(close).toHaveBeenCalledExactlyOnceWith(fixture.generatedSessionId);
    expect(fixture.store.getSession(fixture.generatedSessionId).descriptor).toMatchObject({ archived: true });
    expect(fixture.store.getSession(fixture.generatedSessionId).descriptor.deletedAt).toBeUndefined();
    expect(response.operation?.result?.payload).toMatchObject({
      case: "scheduleDeletion",
      value: { completedSessionIds: [fixture.generatedSessionId], failures: [] }
    });
  });

  it("persists deletion intent before coordinator idle and re-snapshots a generated task created by an earlier flight", async () => {
    const fixture = createFixture();
    let releaseBegin!: () => void;
    let markBeginEntered!: () => void;
    const beginEntered = new Promise<void>((resolve) => { markBeginEntered = resolve; });
    const beginGate = new Promise<void>((resolve) => { releaseBegin = resolve; });
    const lateSessionId = "generated-session-from-earlier-flight";
    fixture.beginScheduleDeletion.mockImplementation(async () => {
      markBeginEntered();
      fixture.store.createSession({
        id: lateSessionId,
        backendId: "backend",
        targetId: "target",
        title: "Late generated task",
        binding: { opaqueRef: "native/generated-late", generation: 0 },
        pinned: false,
        archived: false,
        permissionMode: "ask",
        planMode: false,
        fastMode: false,
        automationOrigin: {
          kind: "scheduler",
          scheduleId: fixture.scheduleId,
          scheduleName: "Generated task",
          runId: "late-origin-run"
        },
        createdAt: 2,
        updatedAt: 2
      });
      await beginGate;
      return ["occurrence-before-fence"];
    });
    const close = vi.fn(async (_sessionId: string) => undefined);
    const services = servicesFor(fixture, close);
    const operationId = "delete-intent-before-idle";

    const submission = services.operation.submitOperation(deleteRequest(
      fixture.connection.id,
      operationId,
      fixture.scheduleId
    ), context());
    await beginEntered;

    expect(fixture.store.getOperation(operationId).status).toBe("started");
    expect(fixture.store.getSchedule(fixture.scheduleId).enabled).toBe(false);
    expect(fixture.store.getScheduleDeletionCleanup(operationId)).toMatchObject({
      state: "pending",
      generatedSessionIds: [fixture.generatedSessionId]
    });

    releaseBegin();
    const response = await submission;

    expect(close.mock.calls.map(([sessionId]) => sessionId).sort()).toEqual([
      fixture.generatedSessionId,
      lateSessionId
    ].sort());
    expect(fixture.store.getScheduleDeletionCleanup(operationId)).toMatchObject({
      state: "completed",
      generatedSessionIds: [fixture.generatedSessionId, lateSessionId].sort(),
      occurrenceRunIds: ["occurrence-before-fence"],
      inflightCount: 1
    });
    expect(response.operation?.result?.payload).toMatchObject({
      case: "scheduleDeletion",
      value: {
        generatedSessionIds: [fixture.generatedSessionId, lateSessionId].sort(),
        inflightCount: 1,
        failures: []
      }
    });
  });

  it("retries one pending cleanup attempt per backoff cycle without requiring a restart", async () => {
    vi.useFakeTimers();
    const fixture = createFixture();
    let attempts = 0;
    const close = vi.fn(async () => {
      attempts += 1;
      if (attempts <= 1) throw new Error("temporary runtime close failure");
    });
    const services = servicesFor(fixture, close);
    const operationId = "delete-generated-online-retry";

    const pendingResponse = await services.operation.submitOperation(deleteRequest(
      fixture.connection.id,
      operationId,
      fixture.scheduleId
    ), context());
    expect(pendingResponse.operation).toMatchObject({
      state: contract.OperationState.RUNNING,
      result: undefined
    });
    expect(close).toHaveBeenCalledTimes(1);
    expect(fixture.store.getOperation(operationId).status).toBe("started");
    expect(fixture.store.getScheduleDeletionCleanup(operationId).state).toBe("pending");
    expect(fixture.store.getSchedule(fixture.scheduleId).enabled).toBe(false);
    expect(fixture.store.getSession(fixture.generatedSessionId).descriptor.automationOrigin?.scheduleId)
      .toBe(fixture.scheduleId);
    expect(fixture.store.getSession(fixture.generatedSessionId).descriptor.deletedAt).toBeUndefined();

    const watch = services.operation.watchOperation(create(contract.WatchOperationRequestSchema, {
      operationId,
      afterRevision: pendingResponse.operation?.version?.revision
    }), context())[Symbol.asyncIterator]();
    const watchedTerminal = watch.next();
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(2_000);

    const watched = await watchedTerminal;
    expect(watched.done).toBe(false);
    expect(watched.value?.operation).toMatchObject({
      operationId,
      state: contract.OperationState.SUCCEEDED,
      result: {
        payload: {
          case: "scheduleDeletion",
          value: { failures: [] }
        }
      }
    });
    await expect(watch.next()).resolves.toMatchObject({ done: true });

    expect(close).toHaveBeenCalledTimes(2);
    expect(fixture.store.getScheduleDeletionCleanup(operationId).state).toBe("completed");
    expect(fixture.store.findSchedule(fixture.scheduleId)).toBeUndefined();
    expect(fixture.store.getSession(fixture.generatedSessionId).descriptor.deletedAt).toBeDefined();
    expect(fixture.releaseScheduleDeletion).toHaveBeenCalledWith(fixture.scheduleId, operationId);
    expect(fixture.store.getOperation(operationId)).toMatchObject({
      status: "completed",
      response: {
        accepted: true,
        resultCase: "scheduleDeletion",
        scheduleDeletion: { failures: [] }
      }
    });

    const replay = await services.operation.submitOperation(deleteRequest(
      fixture.connection.id,
      operationId,
      fixture.scheduleId
    ), context());
    expect(replay.operation?.result?.payload).toMatchObject({
      case: "scheduleDeletion",
      value: { failures: [] }
    });
  });

  it("caps repeated in-process cleanup failures with exponential backoff", async () => {
    vi.useFakeTimers();
    const fixture = createFixture();
    const close = vi.fn(async () => {
      throw new Error("persistent runtime close failure");
    });
    const services = servicesFor(fixture, close);
    const operationId = "delete-generated-bounded-retry";

    const pendingResponse = await services.operation.submitOperation(deleteRequest(
      fixture.connection.id,
      operationId,
      fixture.scheduleId
    ), context());
    expect(pendingResponse.operation).toMatchObject({ state: contract.OperationState.RUNNING, result: undefined });
    expect(close).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);

    // Initial attempt, then retries at 2s, 6s, 14s, 30s, and 60s. A fixed
    // tight loop would issue roughly ninety calls in the same interval.
    expect(close).toHaveBeenCalledTimes(6);
    expect(fixture.store.getScheduleDeletionCleanup(operationId).state).toBe("pending");
    expect(vi.getTimerCount()).toBe(1);
  });

  it("cancels pending cleanup timers before the durable store shuts down", async () => {
    vi.useFakeTimers();
    const fixture = createFixture();
    const close = vi.fn(async () => {
      throw new Error("runtime close remains unavailable");
    });
    const services = servicesFor(fixture, close);

    const pendingResponse = await services.operation.submitOperation(deleteRequest(
      fixture.connection.id,
      "delete-generated-shutdown",
      fixture.scheduleId
    ), context());
    expect(pendingResponse.operation).toMatchObject({ state: contract.OperationState.RUNNING, result: undefined });
    expect(close).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);

    fixture.serviceCleanup();
    fixture.store.close();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(close).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps a claimed project deletion recoverable after its durable manifest is written", async () => {
    vi.useFakeTimers();
    const fixture = createFixture();
    const current = fixture.store.getSchedule(fixture.scheduleId);
    fixture.store.upsertSchedule({
      ...current,
      executionSnapshot: {
        projectAutomation: { format: 1, targetId: "target", configId: "project-task" }
      },
      expectedRevision: current.revision,
      now: 2
    });
    const configDirectory = join(fixture.directory, ".joko", "automations");
    const configPath = join(configDirectory, "schedules.json");
    mkdirSync(configDirectory, { recursive: true });
    writeFileSync(configPath, "{invalid\n", "utf8");
    const close = vi.fn(async () => undefined);
    const services = servicesFor(fixture, close);
    const operationId = "delete-project-recoverable";

    const pendingResponse = await services.operation.submitOperation(deleteRequest(
      fixture.connection.id,
      operationId,
      fixture.scheduleId
    ), context());
    expect(pendingResponse.operation).toMatchObject({ state: contract.OperationState.RUNNING, result: undefined });
    expect(fixture.store.getOperation(operationId).status).toBe("started");
    expect(fixture.store.getScheduleDeletionCleanup(operationId).state).toBe("pending");
    expect(fixture.store.getSchedule(fixture.scheduleId).enabled).toBe(false);

    rmSync(configPath);
    await vi.advanceTimersByTimeAsync(2_000);

    await vi.waitFor(() => {
      expect(fixture.store.getScheduleDeletionCleanup(operationId).state).toBe("completed");
    });
    expect(fixture.store.findSchedule(fixture.scheduleId)).toBeUndefined();
    expect(fixture.store.getOperation(operationId)).toMatchObject({
      status: "completed",
      response: { accepted: true, resultCase: "scheduleDeletion" }
    });
    expect(close).toHaveBeenCalledWith(fixture.generatedSessionId);
  });
});

function servicesFor(
  fixture: ReturnType<typeof createFixture>,
  close: (sessionId: string) => Promise<void>,
  prepareDestructiveSessionClose: (sessionId: string) => Promise<void> = async () => undefined
) {
  const sessionHost = durableMutationHost(
    fixture.store,
    fixture.connection,
    close,
    prepareDestructiveSessionClose
  );
  return createConnectServices({
    config: { publicOrigin: "https://orchestrator.example.test" },
    store: fixture.store,
    connections: {
      authenticate: () => fixture.connection,
      onRevoked: () => () => undefined,
      fence: () => undefined
    },
    artifacts: {},
    blobTransfers: {},
    artifactRepository: {},
    workspaces: {},
    workspaceChanges: {},
    sessionHost,
    scheduler: {
      beginScheduleDeletion: fixture.beginScheduleDeletion,
      releaseScheduleDeletion: fixture.releaseScheduleDeletion
    },
    adapters: [],
    browserActivity: [],
    registerServiceCleanup: (cleanup: () => void) => {
      fixture.serviceCleanup = cleanup;
      return () => {
        if (fixture.serviceCleanup === cleanup) fixture.serviceCleanup = () => undefined;
      };
    },
    close: async () => undefined
  } as unknown as OrchestratorApplication);
}

function durableMutationHost(
  store: OperationalStore,
  connection: ConnectionRecord,
  close: (sessionId: string) => Promise<void>,
  prepareDestructiveSessionClose: (sessionId: string) => Promise<void>
): SessionHost {
  return {
    close,
    closeIfActive: close,
    prepareDestructiveSessionClose,
    async mutate<T>(input: {
      readonly operationId: string;
      readonly connection: ConnectionRecord;
      readonly kind: string;
      readonly body: unknown;
      readonly commit: (target: OperationalStore) => T;
      readonly precondition?: (target: OperationalStore) => void;
      readonly effect?: () => Promise<void>;
      readonly complete?: (
        commit: () => OperationExecution<T>
      ) => Promise<OperationExecution<T>>;
      readonly preserveClaimOnEffectFailure?: (error: unknown) => boolean;
    }): Promise<OperationExecution<T>> {
      const claim = store.claimAuthorizedDeferredEffectOperation<T>(
        connection.id,
        connection.authKeyDigest,
        { id: input.operationId, kind: input.kind, body: input.body },
        input.precondition
      );
      if (!claim.claimed) return { replayed: true, value: claim.value, operation: claim.operation };
      try {
        await input.effect?.();
        const commit = () => store.completeAuthorizedDeferredEffectOperation(
          connection.id,
          connection.authKeyDigest,
          input.operationId,
          claim.operation.bodyHash,
          input.commit
        );
        return input.complete === undefined ? commit() : await input.complete(commit);
      } catch (error) {
        if (input.preserveClaimOnEffectFailure?.(error) !== true) {
          store.failEffectOperation(input.operationId, claim.operation.bodyHash, error);
        }
        throw error;
      }
    }
  } as unknown as SessionHost;
}

function deleteRequest(
  connectionId: string,
  operationId: string,
  scheduleId: string,
  disposition = contract.ScheduleGeneratedSessionDisposition.DELETE
) {
  return create(contract.SubmitOperationRequestSchema, {
    operationId,
    connectionId,
    mutation: create(contract.OperationMutationSchema, {
      payload: {
        case: "deleteSchedule",
        value: create(contract.DeleteScheduleMutationSchema, {
          scheduleId,
          generatedSessionDisposition: disposition
        })
      }
    })
  });
}

function context(): never {
  return { requestHeader: new Headers(), signal: new AbortController().signal } as never;
}

function createFixture() {
  const directory = mkdtempSync(join(tmpdir(), "joko-schedule-deletion-"));
  const store = new OperationalStore(join(directory, "store.sqlite"));
  cleanups.push(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  store.upsertBackend({
    id: "backend",
    displayName: "Backend",
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
    id: "target",
    backendId: "backend",
    displayName: "Workspace",
    workspaceRoot: directory,
    managed: false,
    trusted: true
  });
  const connection = store.createConnection({
    id: "connection",
    name: "Test client",
    authKeyDigest: "digest"
  });
  const scheduleId = "schedule-generated";
  store.upsertSchedule({
    id: scheduleId,
    backendId: "backend",
    targetId: "target",
    sessionMode: "fresh",
    name: "Generated task",
    kind: "manual",
    timezone: "UTC",
    enabled: true,
    prompt: { text: "run", images: [], files: [], mentions: [], disposition: "prompt" },
    executionSnapshot: {},
    overlapPolicy: "queue",
    misfirePolicy: "run_once"
  });
  const generatedSessionId = "generated-session";
  store.createSession({
    id: generatedSessionId,
    backendId: "backend",
    targetId: "target",
    title: "Generated task",
    binding: { opaqueRef: "native/generated", generation: 0 },
    pinned: false,
    archived: false,
    permissionMode: "ask",
    planMode: false,
    fastMode: false,
    automationOrigin: {
      kind: "scheduler",
      scheduleId,
      scheduleName: "Generated task",
      runId: "generated-run"
    },
    createdAt: 1,
    updatedAt: 1
  });
  const beginScheduleDeletion = vi.fn(async (_scheduleId: string, _operationId: string) => [] as readonly string[]);
  const releaseScheduleDeletion = vi.fn();
  let serviceCleanup: () => void = () => undefined;
  return {
    directory,
    store,
    connection,
    scheduleId,
    generatedSessionId,
    beginScheduleDeletion,
    releaseScheduleDeletion,
    serviceCleanup
  };
}
