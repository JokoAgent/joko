import { rmSync } from "node:fs";
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

describe("durable task lifecycle cleanup", () => {
  it("continues after native deletion when workspace release fails without repeating completed phases", async () => {
    vi.useFakeTimers();
    const fixture = createFixture();
    fixture.releaseWorktree.mockRejectedValueOnce(new Error("temporary workspace release failure"));
    const services = servicesFor(fixture);
    const operationId = "delete-session-worktree-retry";

    const pending = await services.operation.submitOperation(deleteRequest(
      fixture.connection.id,
      operationId,
      fixture.sessionId
    ), context());

    expect(pending.operation).toMatchObject({
      operationId,
      state: contract.OperationState.RUNNING,
      result: undefined
    });
    expect(fixture.closeIfActive).toHaveBeenCalledTimes(1);
    expect(fixture.deleteNativeSession).toHaveBeenCalledExactlyOnceWith(fixture.sessionId, operationId);
    expect(fixture.releaseWorktree).toHaveBeenCalledTimes(1);
    expect(fixture.closeGitSafety).not.toHaveBeenCalled();
    expect(fixture.store.getSessionLifecycleCleanup(operationId)).toMatchObject({
      state: "pending",
      closeCompleted: true,
      nativeCompleted: true,
      worktreeCompleted: false,
      gitSafetyCompleted: false
    });
    expect(fixture.store.getOperation(operationId).status).toBe("started");
    expect(fixture.store.getSession(fixture.sessionId).descriptor.deletedAt).toBeUndefined();
    expect(() => fixture.store.createRun({
      id: "run-during-delete-retry",
      sessionId: fixture.sessionId,
      source: "user",
      state: "queued",
      createdAt: 10
    })).toThrow(/lifecycle transition is in progress/iu);

    await vi.advanceTimersByTimeAsync(2_000);

    expect(fixture.closeIfActive).toHaveBeenCalledTimes(1);
    expect(fixture.deleteNativeSession).toHaveBeenCalledTimes(1);
    expect(fixture.releaseWorktree).toHaveBeenCalledTimes(2);
    expect(fixture.closeGitSafety).toHaveBeenCalledTimes(1);
    expect(fixture.store.getSessionLifecycleCleanup(operationId).state).toBe("completed");
    expect(fixture.store.getSession(fixture.sessionId).descriptor.deletedAt).toBeDefined();
    expect(fixture.store.getOperation(operationId)).toMatchObject({
      status: "completed",
      response: { accepted: true, resultCase: "session", entityId: fixture.sessionId }
    });
  });

  it("recovers a pending native deletion after service restart", async () => {
    const fixture = createFixture();
    fixture.releaseWorktree.mockRejectedValueOnce(new Error("process stopped after native deletion"));
    const firstServices = servicesFor(fixture);
    const operationId = "delete-session-restart-recovery";

    const pending = await firstServices.operation.submitOperation(deleteRequest(
      fixture.connection.id,
      operationId,
      fixture.sessionId
    ), context());
    expect(pending.operation?.state).toBe(contract.OperationState.RUNNING);
    expect(fixture.deleteNativeSession).toHaveBeenCalledTimes(1);
    expect(fixture.store.getSessionLifecycleCleanup(operationId)).toMatchObject({
      nativeCompleted: true,
      worktreeCompleted: false
    });
    fixture.disposeServices();

    servicesFor(fixture);
    await vi.waitFor(() => {
      expect(fixture.store.getOperation(operationId).status).toBe("completed");
    });

    expect(fixture.deleteNativeSession).toHaveBeenCalledTimes(1);
    expect(fixture.releaseWorktree).toHaveBeenCalledTimes(2);
    expect(fixture.store.getSessionLifecycleCleanup(operationId).state).toBe("completed");
    expect(fixture.store.getSession(fixture.sessionId).descriptor.deletedAt).toBeDefined();
  });

  it("replays native deletion with the same operation identity when its phase commit is interrupted", async () => {
    vi.useFakeTimers();
    const fixture = createFixture();
    const originalAdvance = fixture.store.advanceSessionLifecycleCleanup.bind(fixture.store);
    let interruptNativePhase = true;
    vi.spyOn(fixture.store, "advanceSessionLifecycleCleanup").mockImplementation((input) => {
      if (input.phase === "native" && interruptNativePhase) {
        interruptNativePhase = false;
        throw new Error("simulated process stop before native phase persistence");
      }
      return originalAdvance(input);
    });
    const operationId = "delete-session-native-phase-replay";
    const services = servicesFor(fixture);

    const pending = await services.operation.submitOperation(deleteRequest(
      fixture.connection.id,
      operationId,
      fixture.sessionId
    ), context());
    expect(pending.operation?.state).toBe(contract.OperationState.RUNNING);
    expect(fixture.deleteNativeSession).toHaveBeenCalledExactlyOnceWith(fixture.sessionId, operationId);
    expect(fixture.store.getSessionLifecycleCleanup(operationId)).toMatchObject({
      closeCompleted: true,
      nativeCompleted: false
    });

    await vi.advanceTimersByTimeAsync(2_000);

    expect(fixture.deleteNativeSession).toHaveBeenCalledTimes(2);
    expect(fixture.deleteNativeSession.mock.calls).toEqual([
      [fixture.sessionId, operationId],
      [fixture.sessionId, operationId]
    ]);
    expect(fixture.store.getSessionLifecycleCleanup(operationId).state).toBe("completed");
    expect(fixture.store.getOperation(operationId).status).toBe("completed");
  });

  it("continues from completed workspace release when Git cleanup fails", async () => {
    vi.useFakeTimers();
    const fixture = createFixture();
    fixture.closeGitSafety.mockRejectedValueOnce(new Error("temporary Git safety failure"));
    const services = servicesFor(fixture);
    const operationId = "delete-session-git-retry";

    const pending = await services.operation.submitOperation(deleteRequest(
      fixture.connection.id,
      operationId,
      fixture.sessionId,
      false
    ), context());
    expect(pending.operation?.state).toBe(contract.OperationState.RUNNING);
    expect(fixture.releaseWorktree).toHaveBeenCalledTimes(1);
    expect(fixture.closeGitSafety).toHaveBeenCalledTimes(1);
    expect(fixture.store.getSessionLifecycleCleanup(operationId)).toMatchObject({
      nativeCompleted: true,
      worktreeCompleted: true,
      gitSafetyCompleted: false
    });

    await vi.advanceTimersByTimeAsync(2_000);

    expect(fixture.releaseWorktree).toHaveBeenCalledTimes(1);
    expect(fixture.closeGitSafety).toHaveBeenCalledTimes(2);
    expect(fixture.store.getSessionLifecycleCleanup(operationId).state).toBe("completed");
    expect(fixture.store.getSession(fixture.sessionId).descriptor.deletedAt).toBeDefined();
  });

  it("recovers archive after workspace preservation succeeds but the final Store commit fails", async () => {
    const fixture = createFixture();
    const originalFinalize = fixture.store.finalizeSessionLifecycleCleanup.bind(fixture.store);
    vi.spyOn(fixture.store, "finalizeSessionLifecycleCleanup")
      .mockImplementationOnce(() => { throw new Error("simulated final Store commit failure"); })
      .mockImplementation((input) => originalFinalize(input));
    const firstServices = servicesFor(fixture);
    const operationId = "archive-session-finalize-recovery";

    const pending = await firstServices.operation.submitOperation(archiveRequest(
      fixture.connection.id,
      operationId,
      fixture.sessionId
    ), context());
    expect(pending.operation).toMatchObject({ state: contract.OperationState.RUNNING, result: undefined });
    expect(fixture.archiveWorktree).toHaveBeenCalledTimes(1);
    expect(fixture.store.getSessionLifecycleCleanup(operationId)).toMatchObject({
      state: "pending",
      closeCompleted: true,
      worktreeCompleted: true
    });
    expect(fixture.store.getSession(fixture.sessionId).descriptor.archived).toBe(false);
    expect(fixture.store.getOperation(operationId).status).toBe("started");
    fixture.disposeServices();

    servicesFor(fixture);
    await vi.waitFor(() => {
      expect(fixture.store.getOperation(operationId).status).toBe("completed");
    });

    expect(fixture.archiveWorktree).toHaveBeenCalledTimes(1);
    expect(fixture.store.getSessionLifecycleCleanup(operationId).state).toBe("completed");
    expect(fixture.store.getSession(fixture.sessionId).descriptor.archived).toBe(true);
    expect(fixture.store.getSession(fixture.sessionId).descriptor.deletedAt).toBeUndefined();
  });
});

function servicesFor(fixture: ReturnType<typeof createFixture>) {
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
    sessionHost: fixture.host,
    sessionWorktrees: {
      archive: fixture.archiveWorktree,
      release: fixture.releaseWorktree
    },
    gitSafety: { closeSession: fixture.closeGitSafety },
    scheduler: {
      beginScheduleDeletion: async () => [],
      releaseScheduleDeletion: () => undefined
    },
    adapters: [],
    browserActivity: [],
    registerServiceCleanup: (cleanup: () => void) => {
      fixture.serviceCleanups.add(cleanup);
      return () => fixture.serviceCleanups.delete(cleanup);
    },
    close: async () => undefined
  } as unknown as OrchestratorApplication);
}

function durableMutationHost(
  store: OperationalStore,
  connection: ConnectionRecord,
  effects: {
    readonly closeIfActive: (sessionId: string) => Promise<void>;
    readonly deleteNativeSession: (sessionId: string, operationId?: string) => Promise<void>;
    readonly prepareSessionLifecycleClose: (sessionId: string, disposition: "archive" | "delete") => Promise<void>;
  }
): SessionHost {
  return {
    ...effects,
    assertSessionLifecycleIdle: () => undefined,
    async mutate<T>(input: {
      readonly operationId: string;
      readonly connection: ConnectionRecord;
      readonly kind: string;
      readonly body: unknown;
      readonly commit: (target: OperationalStore) => T;
      readonly precondition?: (target: OperationalStore) => void;
      readonly effect?: () => Promise<void>;
      readonly complete?: (commit: () => OperationExecution<T>) => Promise<OperationExecution<T>>;
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
  sessionId: string,
  deleteNativeSession = true
) {
  return create(contract.SubmitOperationRequestSchema, {
    operationId,
    connectionId,
    mutation: create(contract.OperationMutationSchema, {
      payload: {
        case: "deleteSession",
        value: create(contract.DeleteSessionMutationSchema, {
          sessionId,
          deleteNativeSession,
          deleteArtifacts: true
        })
      }
    })
  });
}

function archiveRequest(connectionId: string, operationId: string, sessionId: string) {
  return create(contract.SubmitOperationRequestSchema, {
    operationId,
    connectionId,
    mutation: create(contract.OperationMutationSchema, {
      payload: {
        case: "archiveSession",
        value: create(contract.ArchiveSessionMutationSchema, { sessionId, archived: true })
      }
    })
  });
}

function context(): never {
  return { requestHeader: new Headers(), signal: new AbortController().signal } as never;
}

function createFixture() {
  const directory = mkdtempSync(join(tmpdir(), "joko-session-lifecycle-"));
  const store = new OperationalStore(join(directory, "store.sqlite"));
  const serviceCleanups = new Set<() => void>();
  cleanups.push(() => {
    for (const cleanup of serviceCleanups) cleanup();
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
  const sessionId = "session-lifecycle";
  store.createSession({
    id: sessionId,
    backendId: "backend",
    targetId: "target",
    title: "Lifecycle task",
    binding: { opaqueRef: "native/lifecycle", generation: 0 },
    pinned: false,
    archived: false,
    permissionMode: "ask",
    planMode: false,
    fastMode: false,
    worktree: {
      leaseId: "lease-lifecycle",
      workspaceId: "workspace-lifecycle",
      path: join(directory, "worktree"),
      repositoryRoot: directory,
      branch: "joko/ephemeral/lifecycle",
      sourceRef: "refs/heads/main",
      sourceCommit: "a".repeat(40),
      sourceStrategy: "current_branch",
      sourceRefreshed: false,
      state: "active",
      acquiredAt: 1,
      updatedAt: 1
    },
    createdAt: 1,
    updatedAt: 1
  });
  const connection = store.createConnection({
    id: "connection",
    name: "Test client",
    authKeyDigest: "digest"
  });
  const closeIfActive = vi.fn(async (_sessionId: string) => undefined);
  const deleteNativeSession = vi.fn(async (_sessionId: string, _operationId?: string) => undefined);
  const prepareSessionLifecycleClose = vi.fn(async (_sessionId: string, _disposition: "archive" | "delete") => undefined);
  const archiveWorktree = vi.fn(async (id: string) => {
    store.updateSessionWorktreeState(id, "preserved", Date.now());
  });
  const releaseWorktree = vi.fn(async (_id: string) => undefined);
  const closeGitSafety = vi.fn(async (_id: string) => undefined);
  const host = durableMutationHost(store, connection, {
    closeIfActive,
    deleteNativeSession,
    prepareSessionLifecycleClose
  });
  return {
    directory,
    store,
    connection,
    sessionId,
    host,
    closeIfActive,
    deleteNativeSession,
    prepareSessionLifecycleClose,
    archiveWorktree,
    releaseWorktree,
    closeGitSafety,
    serviceCleanups,
    disposeServices() {
      for (const cleanup of [...serviceCleanups]) cleanup();
      serviceCleanups.clear();
    }
  };
}
