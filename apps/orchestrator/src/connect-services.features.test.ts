import { createHash } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "./test-paths.js";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { DurationSchema } from "@bufbuild/protobuf/wkt";
import { Code } from "@connectrpc/connect";
import { PiBackendAdapter } from "@joko/adapter-pi";
import * as contract from "@joko/contracts";
import type { BackendAdapter, NativeSessionState, SessionTreeNode } from "@joko/core";
import { OperationalStore, operationBodyHash, type OperationRecord, type PersistedEvent, type StoredSession } from "@joko/store";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { OrchestratorApplication } from "./application.js";
import { OperationalArtifactRepository } from "./artifact-repository.js";
import { ArtifactStore } from "./artifact-store.js";
import { createConnectServices, registerConnectServices } from "./connect-services.js";
import { ProviderAuthUnsupportedError } from "./credential-manager.js";
import { nativeStateObservation, SESSION_NATIVE_STATE_OBSERVATION_SETTING_KEY } from "./native-state-observation.js";
import { toProtoEventCursor, toProtoTimestamp } from "./proto-mapper.js";
import { SESSION_RUNTIME_STATE_SETTING_KEY } from "./session-runtime-state.js";

const connection = {
  id: "connection-features",
  name: "Feature tests",
  authKeyDigest: "digest",
  state: "active" as const,
  pairedAt: 1,
  revision: 1n
};

const cleanupPaths: string[] = [];

afterEach(() => {
  for (const path of cleanupPaths.splice(0).reverse()) rmSync(path, { recursive: true, force: true });
});

function context(): unknown {
  return { requestHeader: new Headers({ authorization: "Bearer feature-test" }), signal: new AbortController().signal };
}

function stubApplication(overrides: Record<string, unknown>): OrchestratorApplication {
  const overriddenSessionHost = overrides["sessionHost"];
  const sessionHost = {
    getSessionRuntimeControl: () => ({ effective: undefined }),
    recordUserSessionRuntimeSelection: () => 0,
    ...(typeof overriddenSessionHost === "object" && overriddenSessionHost !== null
      ? overriddenSessionHost
      : {})
  };
  return {
    config: { publicOrigin: "https://orchestrator.example.test" },
    store: {},
    connections: { authenticate: () => connection },
    artifacts: {},
    blobTransfers: {},
    artifactRepository: {},
    workspaces: {},
    workspaceChanges: {},
    scheduler: {},
    adapters: [],
    browserActivity: [],
    close: async () => undefined,
    ...overrides,
    sessionHost
  } as unknown as OrchestratorApplication;
}

function completedRecord(id: string, kind: string, body: unknown, response: unknown): OperationRecord<unknown> {
  return {
    id,
    connectionId: connection.id,
    kind,
    body,
    bodyHash: operationBodyHash(body),
    completionMode: "external_effect",
    status: "completed",
    response,
    createdAt: 1,
    updatedAt: 2,
    revision: 1n
  };
}

function immediateHost(store: object, extra: Record<string, unknown> = {}) {
  return {
    mutate: async (input: {
      operationId: string;
      kind: string;
      body: unknown;
      effect?: () => Promise<void>;
      commit: (store: object) => unknown;
    }) => {
      await input.effect?.();
      const value = input.commit(store);
      return { replayed: false, value, operation: completedRecord(input.operationId, input.kind, input.body, value) };
    },
    ...extra
  };
}

async function invoke<T>(handler: unknown, request: unknown): Promise<T> {
  if (typeof handler !== "function") throw new Error("RPC handler is missing.");
  return await (handler as (request: unknown, handlerContext: unknown) => T | Promise<T>)(request, context());
}

describe("Connect typed feature boundaries", () => {
  it("queries every durable public list at an opaque offset beyond ten thousand with an exact total", async () => {
    const pageToken = Buffer.from("joko-page:10000", "utf8").toString("base64url");
    const page = { pageSize: 2, pageToken };
    const session = {
      revision: 1n,
      descriptor: {
        id: "session-page",
        backendId: "backend-page",
        targetId: "target-page",
        title: "Paged",
        binding: { opaqueRef: "native/session-page", generation: 0 },
        pinned: false,
        archived: false,
        permissionMode: "ask" as const,
        planMode: false,
        fastMode: false,
        createdAt: 1,
        updatedAt: 1
      }
    };
    const run = {
      revision: 1n,
      descriptor: {
        id: "run-page",
        sessionId: session.descriptor.id,
        source: "user" as const,
        state: "queued" as const,
        createdAt: 2
      }
    };
    const queueItem = {
      id: "queue-page",
      sessionId: session.descriptor.id,
      runId: run.descriptor.id,
      operationId: "operation-page",
      disposition: "prompt" as const,
      state: "accepted" as const,
      bodyHash: "sha256:queue-page",
      body: { text: "page", images: [], files: [], mentions: [], disposition: "prompt" as const },
      position: 10_000,
      createdAt: 2,
      updatedAt: 2,
      revision: 1n
    };
    const operation = completedRecord(
      "operation-page",
      "paged",
      { sessionId: session.descriptor.id, targetId: session.descriptor.targetId },
      { accepted: true, resultCase: "acknowledgement" }
    );
    const reviewRun = {
      id: "review-page",
      sourceSessionId: session.descriptor.id,
      targetKind: "task" as const,
      state: "running" as const,
      freshness: "current" as const,
      freshnessCheckedAt: 2,
      createdAt: 2,
      updatedAt: 2,
      revision: 1n
    };
    const reviewEvidenceSeal = {
      version: 1 as const,
      conversationSha256: "a".repeat(64),
      workspaceSha256: "b".repeat(64),
      filesSha256: "c".repeat(64),
      artifactsSha256: "d".repeat(64),
      sealSha256: "e".repeat(64),
      createdAt: 2,
      revision: 1n
    };
    const schedule = {
      id: "schedule-page",
      backendId: session.descriptor.backendId,
      targetId: session.descriptor.targetId,
      sessionMode: "bound" as const,
      sessionId: session.descriptor.id,
      name: "Paged schedule",
      kind: "manual" as const,
      timezone: "UTC",
      enabled: true,
      prompt: { text: "page", images: [], files: [], mentions: [], disposition: "prompt" as const },
      executionSnapshot: {
        useWorktree: false,
        refreshWorktreeRemote: false,
        scheduler: {
          format: 1,
          silentWhenIdle: false,
          notify: { desktop: true },
          executionMode: "agent"
        }
      },
      overlapPolicy: "queue" as const,
      misfirePolicy: "skip" as const,
      createdAt: 1,
      updatedAt: 1,
      revision: 1n
    };
    const scheduleRun = {
      id: 10_001n,
      scheduleId: schedule.id,
      runId: run.descriptor.id,
      sessionId: session.descriptor.id,
      firedAt: 2,
      status: "queued",
      revision: 1n
    };
    const interaction = {
      id: "interaction-page",
      sessionId: session.descriptor.id,
      runId: run.descriptor.id,
      generation: 0,
      kind: "question" as const,
      status: "open" as const,
      payload: {
        id: "interaction-page",
        kind: "question" as const,
        title: "Paged question",
        prompt: "Continue?",
        fields: []
      },
      createdAt: 2,
      revision: 1n
    };
    const artifact = {
      blob: {
        id: "artifact-page",
        sha256: "a".repeat(64),
        byteLength: 4,
        mimeType: "text/plain",
        fileName: "page.txt"
      },
      storageKey: "artifact-page",
      sessionId: session.descriptor.id,
      runId: run.descriptor.id,
      metadata: { kind: "file" },
      createdAt: 2,
      revision: 1n
    };
    const store = {
      listOperations: vi.fn(() => [operation]),
      countOperations: vi.fn(() => 10_001),
      listRuns: vi.fn(() => [run]),
      countRuns: vi.fn(() => 10_001),
      listAttempts: vi.fn(() => []),
      getSession: vi.fn(() => session),
      findSetting: vi.fn(() => undefined),
      findQueueItemByRunId: vi.fn(() => queueItem),
      getRun: vi.fn(() => run),
      listQueueItems: vi.fn(() => [queueItem]),
      countQueueItems: vi.fn(() => 10_001),
      listReviewRuns: vi.fn(() => [reviewRun]),
      countReviewRuns: vi.fn(() => 10_001),
      getReviewRunBundle: vi.fn(() => ({ evidenceSeal: reviewEvidenceSeal })),
      getSchedule: vi.fn(() => schedule),
      listScheduleRuns: vi.fn(() => [scheduleRun]),
      countScheduleRuns: vi.fn(() => 10_001),
      findRun: vi.fn(() => run),
      listInteractions: vi.fn(() => [interaction]),
      countInteractions: vi.fn(() => 10_001),
      listArtifacts: vi.fn(() => [artifact]),
      countArtifacts: vi.fn(() => 10_001)
    };
    const services = createConnectServices(stubApplication({ store }));

    const [operations, runs, queue, reviews, scheduleHistory, interactions, artifacts] = await Promise.all([
      invoke<contract.ListOperationsResponse>(services.operation.listOperations, {
        sessionId: session.descriptor.id,
        targetId: session.descriptor.targetId,
        page
      }),
      invoke<contract.ListRunsResponse>(services.run.listRuns, {
        sessionId: session.descriptor.id,
        targetId: session.descriptor.targetId,
        page
      }),
      invoke<contract.ListQueueItemsResponse>(services.queue.listQueueItems, {
        sessionId: session.descriptor.id,
        targetId: session.descriptor.targetId,
        page
      }),
      invoke<contract.ListReviewRunsResponse>(services.review.listReviewRuns, { page }),
      invoke<contract.ListScheduleRunHistoryResponse>(services.scheduler.listScheduleRunHistory, {
        scheduleId: schedule.id,
        page
      }),
      invoke<contract.ListInteractionsResponse>(services.interaction.listInteractions, {
        sessionId: session.descriptor.id,
        runId: run.descriptor.id,
        page
      }),
      invoke<contract.ListArtifactsResponse>(services.artifact.listArtifacts, {
        sessionId: session.descriptor.id,
        runId: run.descriptor.id,
        page
      })
    ]);

    for (const response of [operations, runs, queue, reviews, scheduleHistory, interactions, artifacts]) {
      expect(response.page).toMatchObject({ totalSize: 10_001n, nextPageToken: "" });
    }
    expect(queue.queueItems[0]?.ordinal).toBe(10_000n);
    expect(reviews.reviewRuns[0]).toMatchObject({
      freshness: { state: contract.ReviewFreshnessState.CURRENT },
      evidence: { sealSha256Hex: reviewEvidenceSeal.sealSha256 }
    });
    expect(store.listOperations).toHaveBeenCalledWith(expect.objectContaining({ offset: 10_000, limit: 2 }));
    expect(store.listRuns).toHaveBeenCalledWith(expect.objectContaining({ offset: 10_000, limit: 2 }));
    expect(store.listQueueItems).toHaveBeenCalledWith(expect.objectContaining({ offset: 10_000, limit: 2 }));
    expect(store.listReviewRuns).toHaveBeenCalledWith(expect.objectContaining({ offset: 10_000, limit: 2 }));
    expect(store.listScheduleRuns).toHaveBeenCalledWith(schedule.id, 2, 10_000);
    expect(store.listInteractions).toHaveBeenCalledWith(expect.objectContaining({ offset: 10_000, limit: 2 }));
    expect(store.listArtifacts).toHaveBeenCalledWith(expect.objectContaining({ offset: 10_000, limit: 2 }));
  });

  it("moves only Session navigation placement through a durable operation", async () => {
    let stored: StoredSession = {
      revision: 7n,
      descriptor: {
        id: "session-project-move",
        backendId: "backend-a",
        targetId: "target-runtime",
        projectId: "target-runtime",
        title: "Movable",
        binding: { opaqueRef: "native/session-project-move", generation: 2 },
        pinned: false,
        archived: false,
        permissionMode: "ask" as const,
        planMode: false,
        fastMode: false,
        createdAt: 1,
        updatedAt: 2
      }
    };
    const moveSessionProject = vi.fn((input: {
      sessionId: string;
      expectedRevision: bigint;
      projectId?: string;
      movedAt?: number;
    }) => {
      stored = {
        revision: stored.revision + 1n,
        descriptor: {
          ...stored.descriptor,
          ...(input.projectId === undefined ? { projectId: undefined } : { projectId: input.projectId }),
          updatedAt: input.movedAt ?? stored.descriptor.updatedAt + 1
        }
      };
      return stored;
    });
    const updateSession = vi.fn((
      _sessionId: string,
      patch: { readonly title?: string; readonly archived?: boolean },
      _expectedRevision: bigint,
      updatedAt: number
    ) => {
      stored = {
        revision: stored.revision + 1n,
        descriptor: { ...stored.descriptor, ...patch, updatedAt }
      };
      return stored;
    });
    const store = {
      findOperation: () => undefined,
      getSession: () => stored,
      getTarget: (id: string) => ({
        descriptor: {
          id,
          backendId: "backend-a",
          workspaceRoot: `D:/${id}`
        },
        metadata: {},
        revision: 1n
      }),
      listRuns: () => [],
      findSetting: () => undefined,
      moveSessionProject,
      updateSession
    };
    const validateCatalogSessionReclassification = vi.fn(async (input: {
      readonly sessionId: string;
      readonly projectId?: string;
      readonly archived: boolean;
      readonly modifiedAt: number;
      readonly snapshotToken: string;
    }) => ({ title: "Imported title", archived: input.archived, modifiedAt: Math.max(stored.descriptor.updatedAt, input.modifiedAt) }));
    const services = createConnectServices(stubApplication({
      store,
      sessionHost: immediateHost(store, { validateCatalogSessionReclassification })
    }));

    const submit = async (
      operationId: string,
      projectId?: string,
      catalogImport?: { readonly archived: boolean; readonly modifiedAt: number }
    ) => invoke<contract.SubmitOperationResponse>(
      services.operation.submitOperation,
      {
        operationId,
        connectionId: connection.id,
        mutation: create(contract.OperationMutationSchema, {
          preconditions: [],
          payload: {
            case: "moveSessionProject",
            value: create(contract.MoveSessionProjectMutationSchema, {
              sessionId: stored.descriptor.id,
              ...(projectId === undefined ? {} : { projectId }),
              ...(catalogImport === undefined ? {} : {
                catalogImport: create(contract.NativeCatalogImportPresentationSchema, {
                  archived: catalogImport.archived,
                  modifiedAt: toProtoTimestamp(catalogImport.modifiedAt),
                  snapshotToken: "catalog-snapshot-token"
                })
              })
            })
          }
        })
      }
    );

    await expect(submit("operation-move-project", "target-project"))
      .resolves.toMatchObject({ operation: { state: contract.OperationState.SUCCEEDED } });
    expect(moveSessionProject).toHaveBeenLastCalledWith({
      sessionId: "session-project-move",
      expectedRevision: 7n,
      projectId: "target-project"
    });
    expect(stored.descriptor).toMatchObject({
      targetId: "target-runtime",
      projectId: "target-project",
      backendId: "backend-a",
      binding: { opaqueRef: "native/session-project-move", generation: 2 }
    });

    await submit("operation-move-dialogue");
    expect(moveSessionProject).toHaveBeenLastCalledWith({
      sessionId: "session-project-move",
      expectedRevision: 8n
    });
    expect(stored.descriptor.projectId).toBeUndefined();

    await submit("operation-import-project", "target-project", { archived: true, modifiedAt: 123 });
    expect(moveSessionProject).toHaveBeenLastCalledWith({
      sessionId: "session-project-move",
      expectedRevision: 9n,
      projectId: "target-project",
      movedAt: 123
    });
    expect(validateCatalogSessionReclassification).toHaveBeenCalledWith({
      sessionId: "session-project-move",
      projectId: "target-project",
      archived: true,
      modifiedAt: 123,
      snapshotToken: "catalog-snapshot-token"
    });
    expect(updateSession).toHaveBeenLastCalledWith(
      "session-project-move",
      { title: "Imported title", archived: true },
      10n,
      123
    );
    expect(stored.descriptor).toMatchObject({ projectId: "target-project", title: "Imported title", archived: true, updatedAt: 123 });
  });

  it("publishes the authenticated content-free Scheduler runtime snapshot", async () => {
    const runtimeSnapshot = vi.fn(() => ({
      schedulerInstanceId: "scheduler-connect-1",
      processId: 99,
      inFlight: 1,
      slotsInUse: 0,
      maxConcurrentRuns: 8,
      inFlightRuns: [{
        scheduleId: "schedule-queued",
        scheduleName: "Queued",
        runId: "run-queued",
        source: "automatic" as const,
        executionMode: "agent" as const,
        startedAt: 1_000,
        slotWaitMs: 250,
        phase: "queued" as const,
        lastProgressAt: 1_100
      }],
      waitingSchedules: [{ scheduleId: "schedule-waiting", scheduleName: "Waiting", waitingSince: 900 }]
    }));
    const services = createConnectServices(stubApplication({ scheduler: { runtimeSnapshot } }));

    const response = await invoke<contract.GetSchedulerRuntimeResponse>(services.scheduler.getSchedulerRuntime, {});

    expect(runtimeSnapshot).toHaveBeenCalledOnce();
    expect(response.runtime).toMatchObject({
      schedulerInstanceId: "scheduler-connect-1",
      processId: 99,
      inFlight: 1,
      slotsInUse: 0,
      maxConcurrentRuns: 8,
      inFlightRuns: [{ phase: contract.ScheduleRunPhase.QUEUED }],
      waitingTasks: [{ scheduleId: "schedule-waiting" }]
    });
  });

  it("rejects an oversized create-session personalization prompt before any host effect", async () => {
    const createSession = vi.fn();
    const mutate = vi.fn();
    const services = createConnectServices(stubApplication({
      store: {
        findOperation: () => undefined,
        getTarget: () => ({ descriptor: { id: "target-personalization", backendId: "pi" }, revision: 1n })
      },
      sessionHost: { createSession, mutate }
    }));

    await expect(invoke(services.operation.submitOperation, {
      operationId: "operation-personalization-too-long",
      connectionId: connection.id,
      mutation: create(contract.OperationMutationSchema, {
        preconditions: [],
        payload: {
          case: "createSession",
          value: create(contract.CreateSessionMutationSchema, {
            backendId: "pi",
            targetId: "target-personalization",
            displayName: "Personalized",
            nativeStart: create(contract.NativeSessionStartSchema, {
              kind: { case: "newSession", value: create(contract.NewNativeSessionSchema, {}) }
            }),
            permissionMode: contract.PermissionMode.ASK,
            appendSystemPrompt: "x".repeat(8_001)
          })
        }
      })
    })).rejects.toMatchObject({ code: Code.InvalidArgument });
    expect(mutate).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
  });

  it("rejects a NUL-bearing create-session personalization prompt before any host effect", async () => {
    const createSession = vi.fn();
    const mutate = vi.fn();
    const services = createConnectServices(stubApplication({
      store: {
        findOperation: () => undefined,
        getTarget: () => ({ descriptor: { id: "target-personalization", backendId: "pi" }, revision: 1n })
      },
      sessionHost: { createSession, mutate }
    }));

    await expect(invoke(services.operation.submitOperation, {
      operationId: "operation-personalization-nul",
      connectionId: connection.id,
      mutation: create(contract.OperationMutationSchema, {
        preconditions: [],
        payload: {
          case: "createSession",
          value: create(contract.CreateSessionMutationSchema, {
            backendId: "pi",
            targetId: "target-personalization",
            displayName: "Personalized",
            nativeStart: create(contract.NativeSessionStartSchema, {
              kind: { case: "newSession", value: create(contract.NewNativeSessionSchema, {}) }
            }),
            permissionMode: contract.PermissionMode.ASK,
            appendSystemPrompt: "valid prefix\0invalid suffix"
          })
        }
      })
    })).rejects.toMatchObject({ code: Code.InvalidArgument });
    expect(mutate).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
  });

  it("ignores a personalization prompt when attaching an existing native task", async () => {
    const operationId = "operation-personalization-attach";
    const nestedId = `internal-${createHash("sha256").update(`createSession:${operationId}`).digest("hex").slice(0, 24)}`;
    const expectedSessionId = `session-${createHash("sha256").update(nestedId).digest("hex").slice(0, 24)}`;
    const createSession = vi.fn(async (_input: Record<string, unknown>) => ({ value: { sessionId: expectedSessionId } }));
    const store = {
      findOperation: () => undefined,
      getTarget: () => ({ descriptor: { id: "target-personalization", backendId: "pi" }, revision: 1n })
    };
    const services = createConnectServices(stubApplication({
      store,
      sessionHost: immediateHost(store, { createSession })
    }));

    await invoke(services.operation.submitOperation, {
      operationId,
      connectionId: connection.id,
      mutation: create(contract.OperationMutationSchema, {
        preconditions: [],
        payload: {
          case: "createSession",
          value: create(contract.CreateSessionMutationSchema, {
            backendId: "pi",
            targetId: "target-personalization",
            displayName: "Attached",
            nativeStart: create(contract.NativeSessionStartSchema, {
              kind: { case: "attach", value: create(contract.AttachNativeSessionSchema, { opaqueNativeReference: "native-existing" }) }
            }),
            permissionMode: contract.PermissionMode.ASK,
            appendSystemPrompt: "This value must not mutate existing native history."
          })
        }
      })
    });

    expect(createSession).toHaveBeenCalledOnce();
    expect(createSession.mock.calls[0]?.[0]).toMatchObject({
      nativeStart: { kind: "attach", nativeReference: "native-existing" }
    });
    expect(createSession.mock.calls[0]?.[0]).not.toHaveProperty("appendSystemPrompt");
  });

  it("returns and replays the exact typed SessionAttention acknowledgement result", async () => {
    const descriptor = {
      id: "session-attention-result",
      backendId: "pi",
      targetId: "target-attention-result",
      title: "Attention result",
      binding: { opaqueRef: "pi://attention-result", generation: 3 },
      pinned: false,
      archived: false,
      permissionMode: "ask" as const,
      planMode: false,
      fastMode: false,
      attention: {
        kind: "done" as const,
        unread: true,
        subjectCursor: 40n,
        subjectGeneration: 3,
        attentionCursor: 44n,
        attentionGeneration: 3,
        readThroughCursor: 0n,
        readThroughGeneration: 0,
        updatedAt: 4_400
      },
      createdAt: 1,
      updatedAt: 4_400
    };
    const storedSession = { descriptor, revision: 1n };
    let operation: OperationRecord<unknown> | undefined;
    const acknowledgeSessionAttention = vi.fn((input: { throughCursor: bigint; generation: number; intent: string }) => {
      expect(input).toMatchObject({ throughCursor: 44n, generation: 3, intent: "viewed" });
      descriptor.attention = {
        ...descriptor.attention,
        unread: false,
        readThroughCursor: descriptor.attention.attentionCursor,
        readThroughGeneration: descriptor.attention.attentionGeneration,
        updatedAt: 4_500
      };
      return descriptor.attention;
    });
    const store = {
      findOperation: () => operation,
      getSession: () => storedSession,
      getBackend: () => ({
        descriptor: {
          capabilities: new Map([["session.attention", { key: "session.attention", supported: true }]])
        }
      }),
      findSetting: () => undefined,
      listRuns: () => [],
      acknowledgeSessionAttention
    };
    const sessionHost = {
      mutate: async (input: { operationId: string; kind: string; body: unknown; commit: (store: object) => unknown }) => {
        const value = input.commit(store);
        operation = completedRecord(input.operationId, input.kind, input.body, value);
        return { replayed: false, value, operation };
      }
    };
    const services = createConnectServices(stubApplication({ store, sessionHost }));
    const request = {
      operationId: "operation-attention-result",
      connectionId: connection.id,
      mutation: create(contract.OperationMutationSchema, {
        preconditions: [],
        payload: {
          case: "acknowledgeSessionAttention",
          value: create(contract.AcknowledgeSessionAttentionMutationSchema, {
            sessionId: descriptor.id,
            throughCursor: toProtoEventCursor(44n, 3, 4_400),
            intent: contract.SessionAttentionAcknowledgementIntent.VIEWED
          })
        }
      })
    };

    const first = await invoke<contract.SubmitOperationResponse>(services.operation.submitOperation, request);
    const replay = await invoke<contract.SubmitOperationResponse>(services.operation.submitOperation, request);
    for (const response of [first, replay]) {
      expect(response.operation?.result?.payload).toMatchObject({
        case: "sessionAttention",
        value: {
          kind: contract.SessionAttentionKind.DONE,
          unread: false,
          subjectCursor: { sequence: 40n, generation: 3n },
          attentionCursor: { sequence: 44n, generation: 3n },
          readThroughCursor: { sequence: 44n, generation: 3n }
        }
      });
    }
    expect(acknowledgeSessionAttention).toHaveBeenCalledOnce();
  });

  it("routes typed reset_session without turning /clear into SendInput or changing Product identity", async () => {
    const storedSession = {
      descriptor: {
        id: "session-clear",
        backendId: "pi",
        targetId: "target-clear",
        title: "Clear in place",
        binding: { opaqueRef: "pi://fresh-empty", nativeSessionId: "native-fresh", generation: 8 },
        pinned: false,
        archived: false,
        permissionMode: "ask" as const,
        planMode: false,
        fastMode: false,
        createdAt: 1,
        updatedAt: 2
      },
      revision: 8n
    };
    const store = {
      findOperation: () => undefined,
      getSession: () => storedSession,
      findSetting: () => undefined,
      listRuns: () => []
    };
    const resetSession = vi.fn(async (input: any) => {
      input.precondition?.(store);
      const value = input.result(storedSession);
      return {
        replayed: false,
        value,
        operation: completedRecord(input.operationId, "reset_session", input.body, value)
      };
    });
    const services = createConnectServices(stubApplication({ store, sessionHost: { resetSession } }));
    const response = await invoke<contract.SubmitOperationResponse>(services.operation.submitOperation, {
      operationId: "operation-clear",
      connectionId: connection.id,
      mutation: create(contract.OperationMutationSchema, {
        preconditions: [],
        payload: {
          case: "resetSession",
          value: create(contract.ResetSessionMutationSchema, { sessionId: "session-clear" })
        }
      })
    });

    expect(resetSession).toHaveBeenCalledOnce();
    expect(resetSession.mock.calls[0]?.[0]).toMatchObject({ sessionId: "session-clear" });
    expect(response.operation?.mutation?.payload.case).toBe("resetSession");
    expect(response.operation?.result?.payload).toMatchObject({
      case: "session",
      value: { sessionId: "session-clear", displayName: "Clear in place" }
    });
  });

  it("returns the latest durable Pi usage and context in session statistics without inventing missing observations", async () => {
    const observedSessionId = "session-statistics-observed";
    const usageOnlySessionId = "session-statistics-usage-only";
    const missingSessionId = "session-statistics-missing";
    const store = {
      getSession: (sessionId: string) => ({ descriptor: { id: sessionId } }),
      findSetting: (_scope: string, scopeId: string, key: string) => key !== SESSION_RUNTIME_STATE_SETTING_KEY
        ? undefined
        : scopeId === observedSessionId
          ? {
            value: {
              usage: {
                inputTokens: 10,
                outputTokens: 5,
                cacheReadTokens: 3,
                cacheWriteTokens: 2,
                totalTokens: 20,
                contextTokens: 1_024,
                contextWindow: 4_096,
                cost: 0.25
              },
              updatedAt: 1_234
            }
          }
          : scopeId === usageOnlySessionId
            ? {
                value: {
                  usage: {
                    inputTokens: 100,
                    outputTokens: 20,
                    cacheReadTokens: 10,
                    cacheWriteTokens: 5,
                    totalTokens: 135,
                    contextWindow: 8_192,
                    cost: 0.5
                  },
                  updatedAt: 2_345
                }
              }
            : undefined,
      listEvents: () => [{
        globalCursor: 1n,
        payload: {
          type: "message_complete",
          role: "user",
          blocks: [{ kind: "text", text: "Visible prompt" }]
        }
      }, {
        globalCursor: 2n,
        payload: {
          type: "message_complete",
          role: "user",
          blocks: [{ kind: "text", text: "Internal continuation" }],
          automaticContinuation: { recoveryId: "recovery-statistics" }
        }
      }],
      sumRunActiveDuration: () => 0
    };
    const services = createConnectServices(stubApplication({
      store,
      sessionHost: { getTree: async () => ({ roots: [] }) }
    }));

    const observed = await invoke<any>(services.session.getSessionStatistics, { sessionId: observedSessionId });
    expect(observed.statistics).toMatchObject({
      sessionId: observedSessionId,
      messageCount: 1n,
      usage: {
        inputTokens: 10n,
        outputTokens: 5n,
        cacheReadTokens: 3n,
        cacheWriteTokens: 2n,
        totalTokens: 20n,
        costMicros: 250_000n,
        currencyCode: "USD"
      },
      context: {
        usedTokens: 1_024n,
        contextWindowTokens: 4_096n,
        reservedTokens: 3_072n,
        utilizationRatio: 0.25,
        measuredAt: toProtoTimestamp(1_234)
      }
    });
    expect(observed.statistics.context?.cumulativeUsage).toEqual(observed.statistics.usage);

    const usageOnly = await invoke<any>(services.session.getSessionStatistics, { sessionId: usageOnlySessionId });
    expect(usageOnly.statistics?.usage).toMatchObject({ totalTokens: 135n, costMicros: 500_000n });
    expect(usageOnly.statistics?.context).toBeUndefined();

    const missing = await invoke<any>(services.session.getSessionStatistics, { sessionId: missingSessionId });
    expect(missing.statistics?.usage).toBeUndefined();
    expect(missing.statistics?.context).toBeUndefined();
  });

  it("returns the live session tool registry with source provenance and optional presence intact", async () => {
    const getRuntimeTools = vi.fn(async () => ({
      runtimeGeneration: 7,
      observedAt: 12_345,
      tools: [{
        name: "project_search",
        description: "Search the current project.",
        inputSchema: {
          fields: [{
            fieldPath: "query",
            title: "Query",
            description: "Text to find.",
            type: "string" as const,
            required: true,
            secret: false,
            enumValues: [],
            constraints: { minimumLength: 1 }
          }],
          allowsAdditionalFields: false
        },
        promptGuidelines: ["Use exact terms when available."],
        active: true,
        sourceInfo: {
          path: "extensions/project-search.ts",
          source: "project-search",
          scope: "project" as const,
          origin: "top-level" as const,
          baseDir: "D:\\workspace"
        }
      }, {
        name: "package_lookup",
        description: "Inspect a package.",
        inputSchema: { fields: [], allowsAdditionalFields: true },
        promptGuidelines: [],
        active: false,
        sourceInfo: {
          path: "packages/lookup/index.ts",
          source: "lookup-package",
          scope: "user" as const,
          origin: "package" as const
        }
      }]
    }));
    const services = createConnectServices(stubApplication({
      store: {
        getSession: () => ({ descriptor: { id: "session-tools", backendId: "backend-tools" } }),
        getBackend: () => ({ descriptor: { capabilities: new Map([["runtime.tools", { key: "runtime.tools", supported: true }]]) } })
      },
      sessionHost: { getRuntimeTools }
    }));

    const response = await invoke<contract.GetRuntimeToolCatalogResponse>(services.tool.getRuntimeToolCatalog, {
      sessionId: "session-tools"
    });
    const wire = fromBinary(contract.GetRuntimeToolCatalogResponseSchema, toBinary(
      contract.GetRuntimeToolCatalogResponseSchema,
      create(contract.GetRuntimeToolCatalogResponseSchema, response)
    ));

    expect(getRuntimeTools).toHaveBeenCalledWith("session-tools");
    expect(wire.catalog).toMatchObject({ runtimeGeneration: 7n });
    expect(wire.catalog?.tools[0]).toMatchObject({
      name: "project_search",
      active: true,
      promptGuidelines: ["Use exact terms when available."],
      sourceInfo: {
        scope: contract.RuntimeToolSourceScope.PROJECT,
        origin: contract.RuntimeToolSourceOrigin.TOP_LEVEL,
        baseDir: "D:\\workspace"
      },
      inputSchema: { fields: [{ fieldPath: "query", required: true, constraints: { minimumLength: 1 } }] }
    });
    expect(wire.catalog?.observedAt).toEqual(toProtoTimestamp(12_345));
    expect(wire.catalog?.tools[1]?.sourceInfo?.baseDir).toBeUndefined();
  });

  it("rejects a live tool registry read when the owning Backend does not advertise the capability", async () => {
    const getRuntimeTools = vi.fn();
    const services = createConnectServices(stubApplication({
      store: {
        getSession: () => ({ descriptor: { id: "session-tools-disabled", backendId: "backend-tools-disabled" } }),
        getBackend: () => ({ descriptor: { capabilities: new Map() } })
      },
      sessionHost: { getRuntimeTools }
    }));

    await expect(invoke(services.tool.getRuntimeToolCatalog, { sessionId: "session-tools-disabled" }))
      .rejects.toMatchObject({ code: Code.FailedPrecondition });
    expect(getRuntimeTools).not.toHaveBeenCalled();
  });

  it("commits the Backend-observed effort and clears it for models without public effort choices", async () => {
    const patches: unknown[] = [];
    const store = {
      findOperation: () => undefined,
      findSetting: () => undefined,
      getSession: () => ({ descriptor: { id: "session-model", backendId: "pi" } }),
      getBackend: () => ({
        descriptor: {
          models: [
            { providerId: "provider", modelId: "reasoning", thinkingLevels: ["low", "medium"] },
            { providerId: "provider", modelId: "plain", thinkingLevels: [] }
          ]
        }
      }),
      updateSession: (_sessionId: string, patch: unknown) => {
        patches.push(patch);
        return { descriptor: { id: "session-model" } };
      }
    };
    const applySessionSettings = vi.fn(async (_sessionId: string, fields: { readonly modelId: string }) => ({
      binding: { opaqueRef: "opaque", generation: 1 },
      streaming: false,
      compacting: false,
      pendingMessages: 0,
      providerId: "provider",
      modelId: fields.modelId,
      effort: fields.modelId === "plain" ? "off" : "medium",
      fastMode: fields.modelId === "reasoning",
      permissionMode: "ask" as const
    }));
    const services = createConnectServices(stubApplication({
      store,
      sessionHost: immediateHost(store, { applySessionSettings })
    }));
    const select = async (operationId: string, modelId: string) => invoke(services.operation.submitOperation, {
      operationId,
      connectionId: connection.id,
      mutation: create(contract.OperationMutationSchema, {
        preconditions: [],
        payload: {
          case: "setSessionModel",
          value: create(contract.SetSessionModelMutationSchema, {
            sessionId: "session-model",
            model: create(contract.ModelSelectionSchema, {
              model: create(contract.ModelKeySchema, { providerId: "provider", modelId }),
              fastMode: modelId === "reasoning"
            })
          })
        }
      })
    });

    await select("operation-model-reasoning", "reasoning");
    await select("operation-model-plain", "plain");

    expect(applySessionSettings).toHaveBeenNthCalledWith(1, "session-model", {
      providerId: "provider",
      modelId: "reasoning",
      effort: undefined,
      fastMode: true
    }, { requireNativeObservation: true });
    expect(patches).toEqual([
      { providerId: "provider", modelId: "reasoning", effort: "medium", fastMode: true },
      { providerId: "provider", modelId: "plain", effort: null, fastMode: false }
    ]);
  });

  it("navigates native branches without silently requesting Pi summarization", async () => {
    const store = { findOperation: () => undefined };
    const navigateTree = vi.fn(async () => undefined);
    const services = createConnectServices(stubApplication({
      store,
      sessionHost: immediateHost(store, { navigateTree })
    }));

    await invoke(services.operation.submitOperation, {
      operationId: "operation-navigate-no-summary",
      connectionId: connection.id,
      mutation: create(contract.OperationMutationSchema, {
        preconditions: [],
        payload: {
          case: "navigateSessionBranch",
          value: create(contract.NavigateSessionBranchMutationSchema, {
            sessionId: "session-tree",
            nativeEntryId: "native-user-entry"
          })
        }
      })
    });

    expect(navigateTree).toHaveBeenCalledWith("session-tree", "native-user-entry", false, undefined);
  });

  it("passes bounded branch-summary options through to the Session Host", async () => {
    const store = { findOperation: () => undefined };
    const navigateTree = vi.fn(async () => undefined);
    const services = createConnectServices(stubApplication({
      store,
      sessionHost: immediateHost(store, { navigateTree })
    }));

    await invoke(services.operation.submitOperation, {
      operationId: "operation-navigate-with-summary",
      connectionId: connection.id,
      mutation: create(contract.OperationMutationSchema, {
        preconditions: [],
        payload: {
          case: "navigateSessionBranch",
          value: create(contract.NavigateSessionBranchMutationSchema, {
            sessionId: "session-tree",
            nativeEntryId: "native-user-entry",
            summarize: true,
            customInstructions: "  preserve decisions and API names  "
          })
        }
      })
    });

    expect(navigateTree).toHaveBeenCalledWith(
      "session-tree",
      "native-user-entry",
      true,
      "preserve decisions and API names"
    );
  });

  it("wakes only the resumed session after the authorized queue-control commit", async () => {
    const sessionId = "session-resume-wake";
    const order: string[] = [];
    let paused = true;
    const requestQueueDrain = vi.fn((requestedSessionId: string) => {
      expect(requestedSessionId).toBe(sessionId);
      order.push("drain");
    });
    const store = {
      findOperation: () => undefined,
      setQueuePaused: (input: { readonly sessionId: string; readonly paused: boolean }) => {
        expect(input.sessionId).toBe(sessionId);
        paused = input.paused;
        order.push(`control:${String(input.paused)}`);
        return { sessionId, paused, updatedAt: 2, revision: 2n };
      },
      getQueueControl: () => ({ sessionId, paused, updatedAt: 2, revision: 2n }),
      getSession: () => ({
        descriptor: {
          id: sessionId,
          backendId: "pi",
          targetId: "target-resume-wake",
          binding: { opaqueRef: "pi://resume-wake", generation: 1 }
        },
        revision: 1n
      }),
      listQueueItems: () => []
    };
    const mutate = vi.fn(async (input: {
      operationId: string;
      connection: typeof connection;
      kind: string;
      body: unknown;
      commit: (value: typeof store) => unknown;
    }) => {
      expect(input.connection.id).toBe(connection.id);
      expect(input.connection.authKeyDigest).toBe(connection.authKeyDigest);
      const value = input.commit(store);
      order.push("committed");
      return { replayed: false, value, operation: completedRecord(input.operationId, input.kind, input.body, value) };
    });
    const services = createConnectServices(stubApplication({
      store,
      sessionHost: { mutate, requestQueueDrain }
    }));

    await invoke(services.operation.submitOperation, {
      operationId: "operation-resume-wake",
      connectionId: connection.id,
      mutation: create(contract.OperationMutationSchema, {
        preconditions: [{
          entity: { kind: contract.EntityKind.QUEUE_CONTROL, id: sessionId },
          expectedRevision: { value: 2n },
          expectedGeneration: 1n
        }],
        payload: {
          case: "resumeQueue",
          value: create(contract.ResumeQueueMutationSchema, { sessionId })
        }
      })
    });

    expect(mutate).toHaveBeenCalledOnce();
    expect(requestQueueDrain).toHaveBeenCalledOnce();
    expect(paused).toBe(false);
    expect(order).toEqual(["control:false", "committed", "drain"]);

    await expect(invoke(services.operation.submitOperation, {
      operationId: "operation-resume-without-version",
      connectionId: connection.id,
      mutation: create(contract.OperationMutationSchema, {
        preconditions: [],
        payload: {
          case: "resumeQueue",
          value: create(contract.ResumeQueueMutationSchema, { sessionId })
        }
      })
    })).rejects.toMatchObject({ code: Code.InvalidArgument });
    expect(mutate).toHaveBeenCalledOnce();
  });

  it("round-trips complete Provider BYOM and typed MCP configuration through binary Connect messages", async () => {
    let provider: any;
    let mcpServer: any;
    const providerUpsert = vi.fn(async (input: any) => {
      provider = {
        ...input,
        credentialReferenceIds: Object.values(input.credentialBindings),
        authenticationState: "authenticated",
        version: 3n,
        updatedAt: 30
      };
      return provider;
    });
    const mcpUpsert = vi.fn(async (input: any, _expectedVersion: bigint) => {
      mcpServer = {
        id: input.id,
        displayName: input.displayName,
        transport: input.transport,
        endpointDisplay: input.transport === "stdio" ? input.command : input.endpoint,
        enabled: input.enabled,
        state: "connected",
        runtimeGeneration: 7,
        tools: [{
          serverId: input.id,
          name: "search",
          description: "Search a typed catalog",
          inputSchema: { type: "object", properties: { query: { type: "string", minLength: 1 } }, required: ["query"], additionalProperties: false },
          requiresPermission: true
        }],
        credentialBindings: input.credentialBindings.map((item: any) => ({ ...item, configured: true })),
        configuration: input.transport === "stdio"
          ? {
            case: "stdio",
            command: input.command,
            arguments: [...(input.args ?? [])],
            workingDirectory: input.cwd ?? "",
            environment: { ...(input.environment ?? {}) }
          }
          : { case: "streamableHttp", endpoint: input.endpoint },
        version: 4n,
        updatedAt: 40
      };
      return mcpServer;
    });
    const refreshPiGeneration = vi.fn(async () => undefined);
    const credentialDelete = vi.fn(async () => true);
    const store = {
      findOperation: () => undefined,
      findSetting: () => undefined,
      deleteSetting: vi.fn(),
      health: () => ({ schemaVersion: 1, journalMode: "wal", foreignKeys: true, revision: 1n, globalCursor: 0n }),
      listConnections: () => [],
      listBackends: () => [],
      listTargets: () => [],
      messageEmbeddingStatus: () => ({
        enabled: true,
        vectorAvailable: true,
        modelId: "voyage/voyage-4",
        dimensions: 1_024,
        pendingCount: 0,
        runningCount: 0,
        doneCount: 0,
        failedCount: 0
      })
    };
    const services = createConnectServices(stubApplication({
      store,
      sessionHost: immediateHost(store),
      providers: {
        list: () => provider === undefined ? [] : [provider],
        get: () => provider,
        upsert: providerUpsert,
        resolveOpenAiEmbeddingRoute: () => undefined
      },
      credentials: { list: () => [], delete: credentialDelete },
      mcpRouter: { list: () => mcpServer === undefined ? [] : [mcpServer], get: () => mcpServer, upsert: mcpUpsert },
      piResources: { list: () => [] },
      refreshPiGeneration
    }));

    const providerConfiguration = create(contract.ProviderConfigurationSchema, {
      providerId: "custom-google",
      displayName: "Custom Google",
      kind: contract.ProviderKind.CUSTOM_ENDPOINT,
      apiCompatibility: contract.ProviderApiCompatibility.GOOGLE_GENERATIVE_AI,
      endpoint: "https://models.example.test/v1",
      credentialReferenceId: "credential-reference-1234",
      enabled: true,
      apiKeyEnvironment: "CUSTOM_API_KEY",
      keyless: false,
      authHeader: true,
      headers: [create(contract.ProviderHeaderConfigurationSchema, {
        headerName: "X-Tenant",
        environmentName: "CUSTOM_TENANT",
        credentialReferenceId: "credential-reference-tenant"
      })],
      models: [create(contract.ProviderModelConfigurationSchema, {
        modelId: "reasoner-1",
        displayName: "Reasoner 1",
        apiCompatibility: contract.ProviderApiCompatibility.GOOGLE_GENERATIVE_AI,
        reasoning: true,
        supportsFastMode: true,
        inputModalities: [contract.ModelInputModality.TEXT, contract.ModelInputModality.IMAGE],
        contextWindowTokens: 200_000n,
        maximumOutputTokens: 16_000n,
        inputCostMicrosPerMillion: 1_250_000n,
        outputCostMicrosPerMillion: 5_000_000n,
        cacheReadCostMicrosPerMillion: 250_000n,
        cacheWriteCostMicrosPerMillion: 500_000n,
        thinkingLevels: [create(contract.ProviderThinkingLevelMappingSchema, { effortId: "high", nativeLevel: "deep" })],
        sampling: create(contract.ProviderSamplingConfigurationSchema, { temperature: 0.3, topP: 0.9, seed: 42n }),
        compatibility: create(contract.ProviderCompatibilityConfigurationSchema, { supportsDeveloperRole: true, supportsStrictTools: true, thinkingFormat: "native" })
      })]
    });
    const providerRequest = create(contract.SubmitOperationRequestSchema, {
      operationId: "operation-provider-binary",
      connectionId: connection.id,
      mutation: create(contract.OperationMutationSchema, {
        preconditions: [],
        payload: { case: "upsertProvider", value: create(contract.UpsertProviderMutationSchema, { provider: providerConfiguration }) }
      })
    });
    await invoke(services.operation.submitOperation, fromBinary(
      contract.SubmitOperationRequestSchema,
      toBinary(contract.SubmitOperationRequestSchema, providerRequest)
    ));

    expect(providerUpsert).toHaveBeenCalledOnce();
    expect(provider.provider.api).toBe("google-generative-ai");
    expect(provider.provider.models[0]).toMatchObject({
      id: "reasoner-1",
      contextWindow: 200_000,
      maxTokens: 16_000,
      supportsFastMode: true
    });
    expect(provider.provider.models[0].samplingParams).toMatchObject({ temperature: 0.3, topP: 0.9, seed: 42 });
    expect(provider.credentialBindings).toEqual({ CUSTOM_API_KEY: "credential-reference-1234", CUSTOM_TENANT: "credential-reference-tenant" });

    const mcpInput = create(contract.McpServerInputSchema, {
      displayName: "Local MCP",
      transport: contract.McpTransport.STDIO,
      endpoint: "",
      enabled: true,
      credentialBindings: [create(contract.CredentialBindingSchema, {
        headerName: "",
        credentialReferenceId: "credential-reference-mcp",
        configured: true,
        target: contract.McpCredentialTarget.ENVIRONMENT,
        targetName: "MCP_TOKEN"
      }), create(contract.CredentialBindingSchema, {
        headerName: "",
        credentialReferenceId: "credential-reference-tenant",
        target: contract.McpCredentialTarget.ENVIRONMENT,
        targetName: "MCP_TENANT"
      })],
      transportConfig: { case: "stdio", value: create(contract.StdioMcpConfigurationSchema, {
        command: "node",
        arguments: ["server.mjs"],
        workingDirectory: "D:\\workspace",
        environment: [create(contract.McpEnvironmentVariableSchema, { name: "LOG_LEVEL", value: "info" })]
      }) }
    });
    await expect(invoke(services.operation.submitOperation, {
      operationId: "operation-mcp-unfenced",
      connectionId: connection.id,
      mutation: create(contract.OperationMutationSchema, {
        preconditions: [],
        payload: { case: "upsertMcpServer", value: create(contract.UpsertMcpServerMutationSchema, {
          mcpServerId: "local-mcp",
          server: mcpInput
        }) }
      })
    })).rejects.toMatchObject({ message: "[invalid_argument] expected_revision is required" });
    expect(mcpUpsert).not.toHaveBeenCalled();
    const mcpRequest = create(contract.SubmitOperationRequestSchema, {
      operationId: "operation-mcp-binary",
      connectionId: connection.id,
      mutation: create(contract.OperationMutationSchema, {
        preconditions: [],
        payload: { case: "upsertMcpServer", value: create(contract.UpsertMcpServerMutationSchema, {
          mcpServerId: "local-mcp",
          server: mcpInput,
          expectedRevision: create(contract.RevisionSchema, { value: 0n })
        }) }
      })
    });
    await invoke(services.operation.submitOperation, fromBinary(
      contract.SubmitOperationRequestSchema,
      toBinary(contract.SubmitOperationRequestSchema, mcpRequest)
    ));
    const savedMcpPayload = mcpRequest.mutation?.payload;
    expect(savedMcpPayload?.case).toBe("upsertMcpServer");
    if (savedMcpPayload?.case !== "upsertMcpServer") throw new Error("Expected an MCP upsert payload.");
    expect(JSON.stringify(savedMcpPayload.value.server)).not.toContain("mcp-raw-secret-material");

    expect(mcpUpsert).toHaveBeenCalledWith(expect.objectContaining({
      id: "local-mcp",
      transport: "stdio",
      command: "node",
      args: ["server.mjs"],
      cwd: "D:\\workspace",
      environment: { LOG_LEVEL: "info" },
      credentialBindings: [
        { target: "environment", name: "MCP_TOKEN", credentialReferenceId: "credential-reference-mcp" },
        { target: "environment", name: "MCP_TENANT", credentialReferenceId: "credential-reference-tenant" }
      ]
    }), 0n);
    expect(refreshPiGeneration).toHaveBeenCalledTimes(2);

    const settingsResponse = await invoke<{ settings?: contract.SettingsSnapshot }>(services.settings.getSettings, {});
    const settings = fromBinary(contract.SettingsSnapshotSchema, toBinary(contract.SettingsSnapshotSchema, settingsResponse.settings!));
    expect(settings.providers[0]?.models[0]?.sampling?.seed).toBe(42n);
    expect(settings.providers[0]?.models[0]?.supportsFastMode).toBe(true);
    expect(settings.providers[0]?.headers[0]).toMatchObject({ headerName: "X-Tenant", environmentName: "CUSTOM_TENANT" });
    const mcpResponse = await invoke<{ servers: contract.McpServerDescriptor[]; page?: contract.PageInfo }>(services.tool.listMcpServers, {});
    const mcpWire = fromBinary(contract.ListMcpServersResponseSchema, toBinary(contract.ListMcpServersResponseSchema, create(contract.ListMcpServersResponseSchema, {
      servers: mcpResponse.servers,
      page: mcpResponse.page
    })));
    expect(mcpWire.servers[0]?.credentialBindings).toMatchObject([
      { target: contract.McpCredentialTarget.ENVIRONMENT, targetName: "MCP_TOKEN", credentialReferenceId: "credential-reference-mcp" },
      { target: contract.McpCredentialTarget.ENVIRONMENT, targetName: "MCP_TENANT", credentialReferenceId: "credential-reference-tenant" }
    ]);
    expect(mcpWire.servers[0]).toMatchObject({ enabled: true, transportConfig: { case: "stdio" } });
    expect(mcpWire.servers[0]?.transportConfig.value).toMatchObject({
      command: "node",
      arguments: ["server.mjs"],
      workingDirectory: "D:\\workspace",
      environment: [{ name: "LOG_LEVEL", value: "info" }]
    });
    expect(mcpWire.servers[0]?.tools[0]?.inputSchema?.fields[0]).toMatchObject({ fieldPath: "query", required: true });

    let deleteFailure: unknown;
    try {
      await invoke(services.operation.submitOperation, {
        operationId: "operation-delete-bound-credential",
        connectionId: connection.id,
        mutation: create(contract.OperationMutationSchema, {
          preconditions: [],
          payload: { case: "deleteCredential", value: create(contract.DeleteCredentialMutationSchema, {
            credentialReferenceId: "credential-reference-mcp"
          }) }
        })
      });
    } catch (error) {
      deleteFailure = error;
    }
    expect(deleteFailure).toMatchObject({ message: "[failed_precondition] Credential is still referenced by managed configuration; remove its bindings first." });
    expect(String(deleteFailure)).not.toContain("local-mcp");
    expect(String(deleteFailure)).not.toContain("MCP_TOKEN");
    expect(credentialDelete).not.toHaveBeenCalled();
  });

  it("deletes a native Provider credential through native logout and refreshes the Pi generation", async () => {
    const credentialReferenceId = "credential-reference-native-auth";
    const logout = vi.fn(async () => ({ authenticationState: "signed_out" }));
    const credentialDelete = vi.fn(async () => true);
    const refreshPiGeneration = vi.fn(async () => undefined);
    const nativeProvider = {
      provider: { id: "amazon-bedrock" },
      credentialReferenceIds: [credentialReferenceId],
      nativeCredentialReferenceId: credentialReferenceId
    };
    const store = {
      findOperation: () => undefined,
      listBackends: () => [],
      deleteSetting: vi.fn(),
      health: () => ({ schemaVersion: 1, journalMode: "wal", foreignKeys: true, revision: 1n, globalCursor: 0n })
    };
    const services = createConnectServices(stubApplication({
      store,
      sessionHost: immediateHost(store),
      providers: {
        list: () => [nativeProvider],
        logout
      },
      credentials: { list: () => [], delete: credentialDelete },
      refreshPiGeneration
    }));

    await invoke(services.operation.submitOperation, {
      operationId: "operation-delete-native-credential",
      connectionId: connection.id,
      mutation: create(contract.OperationMutationSchema, {
        preconditions: [],
        payload: {
          case: "deleteCredential",
          value: create(contract.DeleteCredentialMutationSchema, { credentialReferenceId })
        }
      })
    });

    expect(logout).toHaveBeenCalledExactlyOnceWith("amazon-bedrock");
    expect(refreshPiGeneration).toHaveBeenCalledOnce();
    expect(credentialDelete).not.toHaveBeenCalled();
  });

  it("maps binary OpenAI Chat Completions Provider configuration to Pi's completions API", async () => {
    let configured: any;
    const store = {
      findOperation: () => undefined,
      listBackends: () => [],
      deleteSetting: vi.fn(),
      health: () => ({ schemaVersion: 1, journalMode: "wal", foreignKeys: true, revision: 1n, globalCursor: 0n })
    };
    const services = createConnectServices(stubApplication({
      store,
      sessionHost: immediateHost(store),
      providers: {
        list: () => configured === undefined ? [] : [configured],
        get: () => configured,
        upsert: async (input: any) => {
          configured = { ...input, authenticationState: "not_required", version: 1n, updatedAt: 1 };
          return configured;
        }
      },
      credentials: { list: () => [] },
      mcpRouter: { list: () => [] },
      piResources: { list: () => [] },
      refreshPiGeneration: async () => undefined
    }));
    const request = create(contract.SubmitOperationRequestSchema, {
      operationId: "operation-openai-chat-binary",
      connectionId: connection.id,
      mutation: create(contract.OperationMutationSchema, {
        preconditions: [],
        payload: {
          case: "upsertProvider",
          value: create(contract.UpsertProviderMutationSchema, {
            provider: create(contract.ProviderConfigurationSchema, {
              providerId: "chat-endpoint",
              displayName: "Chat endpoint",
              kind: contract.ProviderKind.CUSTOM_ENDPOINT,
              apiCompatibility: contract.ProviderApiCompatibility.OPENAI_CHAT_COMPLETIONS,
              endpoint: "https://chat.example.test/v1",
              enabled: true,
              keyless: true,
              models: [create(contract.ProviderModelConfigurationSchema, {
                modelId: "chat-model",
                displayName: "Chat model",
                apiCompatibility: contract.ProviderApiCompatibility.OPENAI_CHAT_COMPLETIONS
              })]
            })
          })
        }
      })
    });

    await invoke(services.operation.submitOperation, fromBinary(
      contract.SubmitOperationRequestSchema,
      toBinary(contract.SubmitOperationRequestSchema, request)
    ));

    expect(configured.provider).toMatchObject({
      id: "chat-endpoint",
      api: "openai-completions",
      models: [{ id: "chat-model", api: "openai-completions" }]
    });
  });

  it("projects model availability from each Provider's live authentication state", async () => {
    const model = (providerId: string, modelId: string) => ({
      providerId,
      modelId,
      displayName: modelId,
      api: "openai-responses" as const,
      contextWindow: 128_000,
      maxOutputTokens: 16_000,
      supportsImages: true,
      thinkingLevels: ["medium"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    });
    const backend = {
      descriptor: {
        id: "pi",
        displayName: "Pi",
        adapterKind: "pi",
        instanceGeneration: 0,
        installationState: "installed",
        authenticationState: "authenticated",
        models: [model("signed-out", "model-a"), model("ready", "model-b")],
        capabilities: new Map([
          ["provider.managed_catalog", { key: "provider.managed_catalog", supported: true }]
        ])
      },
      revision: 1n,
      updatedAt: 1
    };
    const services = createConnectServices(stubApplication({
      store: { listBackends: () => [backend], getBackend: () => backend },
      providers: {
        list: () => [
          { provider: { id: "signed-out" }, authenticationState: "signed_out" },
          { provider: { id: "ready" }, authenticationState: "authenticated" }
        ]
      }
    }));

    const response = await invoke<{ models: contract.ModelDescriptor[] }>(services.backend.listModels, {
      backendId: "pi",
      providerId: ""
    });

    expect(response.models.map(({ key, available }) => [key?.providerId, available])).toEqual([
      ["signed-out", false],
      ["ready", true]
    ]);
  });

  it("projects durable Tool Calls and aborts the owning Run", async () => {
    const event: PersistedEvent = {
      id: "event-tool-start",
      globalCursor: 1n,
      sequence: 1n,
      revision: 1n,
      emittedAt: 10,
      backendId: "pi",
      targetId: "target-1",
      sessionId: "session-1",
      runId: "run-1",
      attemptId: "attempt-1",
      generation: 1,
      traceId: "trace-1",
      payload: { type: "tool_start", callId: "call-1", name: "read", input: "{\"path\":\"README.md\"}" }
    };
    const abort = vi.fn(async () => undefined);
    const store = {
      findOperation: () => undefined,
      listEvents: ({ afterCursor = 0n, sessionId }: { afterCursor?: bigint; sessionId?: string }) =>
        event.globalCursor > afterCursor && (sessionId === undefined || sessionId === event.sessionId) ? [event] : []
    };
    const services = createConnectServices(stubApplication({ store, sessionHost: immediateHost(store, { abort }) }));

    const listed = await invoke<{ toolCalls: contract.ToolCall[]; page?: contract.PageInfo }>(services.tool.listToolCalls, {
      sessionId: "session-1", runId: "run-1"
    });
    const decoded = fromBinary(contract.ListToolCallsResponseSchema, toBinary(contract.ListToolCallsResponseSchema, create(contract.ListToolCallsResponseSchema, listed)));
    expect(decoded.toolCalls[0]).toMatchObject({ toolCallId: "call-1", state: contract.ToolCallState.RUNNING, runId: "run-1" });
    const fetched = await invoke<{ toolCall?: contract.ToolCall }>(services.tool.getToolCall, { toolCallId: "call-1" });
    expect(fetched.toolCall?.sessionId).toBe("session-1");

    await invoke(services.operation.submitOperation, {
      operationId: "operation-abort-tool",
      connectionId: connection.id,
      mutation: create(contract.OperationMutationSchema, {
        preconditions: [],
        payload: { case: "abortToolCall", value: create(contract.AbortToolCallMutationSchema, { toolCallId: "call-1" }) }
      })
    });
    expect(abort).toHaveBeenCalledWith("session-1", "run-1");
  });

  it("dispatches generic user-shell mutations without a Pi Adapter downcast", async () => {
    const executeUserShell = vi.fn(async () => ({ output: "ok", exitCode: 0, cancelled: false, truncated: false }));
    const abortUserShell = vi.fn(async () => undefined);
    const store = { findOperation: () => undefined };
    const services = createConnectServices(stubApplication({
      store,
      sessionHost: immediateHost(store, { executeUserShell, abortUserShell })
    }));

    const submit = async (operationId: string, payload: contract.OperationMutation["payload"]): Promise<void> => {
      await invoke(services.operation.submitOperation, {
        operationId,
        connectionId: connection.id,
        mutation: create(contract.OperationMutationSchema, { preconditions: [], payload })
      });
    };

    await submit("operation-user-shell", {
      case: "executeUserShell",
      value: create(contract.ExecuteUserShellMutationSchema, {
        sessionId: "session-generic",
        command: "pwd",
        excludeFromContext: true
      })
    });
    await submit("operation-user-shell-abort", {
      case: "abortUserShell",
      value: create(contract.AbortUserShellMutationSchema, { sessionId: "session-generic" })
    });
    expect(executeUserShell).toHaveBeenNthCalledWith(1, "session-generic", {
      command: "pwd",
      excludeFromContext: true
    }, "operation-user-shell");
    expect(abortUserShell).toHaveBeenNthCalledWith(1, "session-generic");
  });

  it("dispatches background task cancellation only through its independent capability", async () => {
    const cancelBackgroundTask = vi.fn(async () => undefined);
    const supported = { descriptor: {
      id: "session-background-cancel",
      backendId: "background-backend",
      binding: { opaqueRef: "native:background", generation: 3 }
    } };
    let cancelSupported = true;
    const store = {
      findOperation: () => undefined,
      getSession: () => supported,
      getBackend: () => ({ descriptor: { capabilities: new Map([[contract.capabilityNames.backgroundTasksCancel, {
        key: contract.capabilityNames.backgroundTasksCancel,
        get supported() { return cancelSupported; }
      }]]) } })
    };
    const services = createConnectServices(stubApplication({
      store,
      sessionHost: immediateHost(store, { cancelBackgroundTask })
    }));
    const mutation = (sessionId: string, backgroundTaskId: string) => create(contract.OperationMutationSchema, {
      preconditions: [],
      payload: {
        case: "cancelBackgroundTask",
        value: create(contract.CancelBackgroundTaskMutationSchema, { sessionId, backgroundTaskId })
      }
    });

    const completed = await invoke<contract.SubmitOperationResponse>(services.operation.submitOperation, {
      operationId: "operation-background-cancel",
      connectionId: connection.id,
      mutation: mutation("session-background-cancel", "background-task-one")
    });
    expect(cancelBackgroundTask).toHaveBeenCalledWith(
      "session-background-cancel",
      "background-task-one",
      "operation-background-cancel"
    );
    expect(completed.operation).toMatchObject({
      state: contract.OperationState.SUCCEEDED,
      result: { payload: { case: "acknowledgement", value: { accepted: true } } }
    });

    cancelSupported = false;
    const unsupported = await invoke<contract.SubmitOperationResponse>(services.operation.submitOperation, {
      operationId: "operation-background-cancel-unsupported",
      connectionId: connection.id,
      mutation: mutation("session-background-cancel", "background-task-two")
    });
    expect(unsupported.operation).toMatchObject({
      state: contract.OperationState.FAILED,
      result: { payload: { case: "acknowledgement", value: { accepted: false } } }
    });

    await expect(invoke(services.operation.submitOperation, {
      operationId: "operation-background-cancel-blank-session",
      connectionId: connection.id,
      mutation: mutation("", "background-task-three")
    })).rejects.toMatchObject({ code: Code.InvalidArgument });
    await expect(invoke(services.operation.submitOperation, {
      operationId: "operation-background-cancel-blank-task",
      connectionId: connection.id,
      mutation: mutation("session-background-cancel", "  ")
    })).rejects.toMatchObject({ code: Code.InvalidArgument });
    expect(cancelBackgroundTask).toHaveBeenCalledTimes(1);
  });

  it("rejects extra-directory approval before mutation when the Backend lacks the capability", async () => {
    const add = vi.fn();
    const refreshTargetExtraDirectories = vi.fn();
    const store = {
      findOperation: () => undefined,
      listTargets: () => [{
        descriptor: { id: "target-extra-disabled", backendId: "arbitrary-backend" },
        metadata: { workspaceId: "workspace-extra-disabled" }
      }],
      getBackend: () => ({
        descriptor: {
          capabilities: new Map([["workspace.extra_dirs", {
            key: "workspace.extra_dirs",
            supported: false,
            reason: "not_implemented"
          }]])
        }
      })
    };
    const services = createConnectServices(stubApplication({
      store,
      sessionHost: immediateHost(store, {
        extraDirectories: { add },
        refreshTargetExtraDirectories
      })
    }));

    const response = await invoke<contract.SubmitOperationResponse>(services.operation.submitOperation, {
      operationId: "operation-extra-directory-disabled",
      connectionId: connection.id,
      mutation: create(contract.OperationMutationSchema, {
        preconditions: [],
        payload: {
          case: "addExtraDirectory",
          value: create(contract.AddExtraDirectoryMutationSchema, {
            workspaceId: "workspace-extra-disabled",
            serverPath: "D:/approved-extra",
            access: contract.ExtraDirectoryAccess.READ_ONLY
          })
        }
      })
    });

    expect(response.operation).toMatchObject({
      state: contract.OperationState.FAILED,
      result: { payload: { case: "acknowledgement", value: { accepted: false } } },
      error: { code: "UNSUPPORTED_CAPABILITY" }
    });
    expect(add).not.toHaveBeenCalled();
    expect(refreshTargetExtraDirectories).not.toHaveBeenCalled();
  });

  it("returns typed Browser transfers for upload and list RPCs", async () => {
    const transfer = create(contract.BrowserTransferSchema, {
      browserTransferId: "transfer-1",
      browserProviderId: "browser",
      pageId: "page-1",
      toolCallId: "",
      direction: contract.TransferDirection.UPLOAD,
      state: contract.BrowserTransferState.COMPLETED
    });
    const upload = vi.fn(async () => transfer);
    const coordinator = { browserProviderId: "browser", upload, get: () => transfer, list: () => [transfer] };
    const takeover = {
      providerId: "browser",
      pageId: "page-1",
      generation: 7,
      owner: connection.id,
      takeoverId: "takeover-upload",
      startedAt: 1_000,
      expiresAt: 61_000
    };
    const browser = { id: "browser", generation: 7, currentHumanTakeover: () => takeover };
    const browserState = {
      findRecoverablePage: () => ({
        browserProviderId: "browser",
        pageId: "page-1",
        generation: 7,
        sessionId: "session-browser",
        targetId: "target-browser",
        bindingGeneration: 1,
        url: "about:blank",
        title: "Page",
        state: "open" as const,
        updatedAt: 1
      })
    };
    const store = { findOperation: () => undefined };
    const services = createConnectServices(stubApplication({ store, sessionHost: immediateHost(store), browser, browserState, browserTransfers: coordinator }));
    const request = create(contract.SubmitOperationRequestSchema, {
      operationId: "operation-browser-upload",
      connectionId: connection.id,
      mutation: create(contract.OperationMutationSchema, {
        preconditions: [],
        payload: { case: "uploadBrowserFile", value: create(contract.UploadBrowserFileMutationSchema, {
          browserProviderId: "browser",
          pageId: "page-1",
          inputHint: "input[type=file]",
          blob: create(contract.BlobRefSchema, {
            blobId: "blob-1",
            fileName: "input.txt",
            mediaType: "text/plain",
            byteSize: 4n,
            sha256Hex: "a".repeat(64),
            disposition: contract.BlobDisposition.ATTACHMENT
          })
        }) }
      })
    });
    const submitted = await invoke<{ operation?: contract.Operation }>(services.operation.submitOperation, fromBinary(
      contract.SubmitOperationRequestSchema,
      toBinary(contract.SubmitOperationRequestSchema, request)
    ));
    expect(upload).toHaveBeenCalledWith(expect.objectContaining({ id: "blob-1" }), "page-1", "input[type=file]", {
      id: connection.id,
      humanTakeover: takeover
    });
    expect(submitted.operation?.result?.payload.case).toBe("browserTransfer");
    const listed = await invoke<{ transfers: contract.BrowserTransfer[]; page?: contract.PageInfo }>(services.browser.listBrowserTransfers, {
      browserProviderId: "browser", pageId: "page-1", direction: contract.TransferDirection.UPLOAD
    });
    const decoded = fromBinary(contract.ListBrowserTransfersResponseSchema, toBinary(contract.ListBrowserTransfersResponseSchema, create(contract.ListBrowserTransfersResponseSchema, listed)));
    expect(decoded.transfers[0]?.browserTransferId).toBe("transfer-1");
  });

  it("pages Browser activity newest-first beyond the UI's first 100 records", async () => {
    const activities = Array.from({ length: 125 }, (_, index) => ({
      at: index + 1,
      type: "action" as const,
      pageId: "page-activity",
      detail: `activity-${index + 1}`
    }));
    const services = createConnectServices(stubApplication({ browserActivity: activities }));
    const first = await invoke<contract.ListBrowserActivityResponse>(services.browser.listBrowserActivity, {
      browserProviderId: "browser",
      pageId: "page-activity",
      page: { pageSize: 100, pageToken: "" }
    });
    expect(first.activities).toHaveLength(100);
    expect(first.activities.slice(0, 20).map((item) => item.description)).toEqual(
      Array.from({ length: 20 }, (_, index) => `activity-${125 - index}`)
    );
    expect(first.page?.totalSize).toBe(125n);
    expect(first.page?.nextPageToken).not.toBe("");

    const second = await invoke<contract.ListBrowserActivityResponse>(services.browser.listBrowserActivity, {
      browserProviderId: "browser",
      pageId: "page-activity",
      page: { pageSize: 100, pageToken: first.page?.nextPageToken ?? "" }
    });
    expect(second.activities.map((item) => item.description)).toEqual(
      Array.from({ length: 25 }, (_, index) => `activity-${25 - index}`)
    );
    expect(second.page?.nextPageToken).toBe("");
  });

  it("applies typed Browser settings, uses the configured takeover TTL, and enforces transfer policy", async () => {
    const applied: contract.BrowserSettingsPatch[] = [];
    let uploadsAllowed = true;
    const browserSettings = {
      apply: vi.fn(async (patch: contract.BrowserSettingsPatch) => {
        applied.push(patch);
        uploadsAllowed = patch.allowUploads ?? uploadsAllowed;
        return create(contract.BrowserSettingsSchema, {
          browserProviderId: "browser",
          profileDisplayName: patch.profileDisplayName ?? "Daily browser",
          takeoverTimeout: patch.takeoverTimeout,
          allowUploads: uploadsAllowed,
          allowDownloads: patch.allowDownloads ?? true
        });
      }),
      enabled: () => true,
      anyTargetEnabled: () => true,
      uploadAllowed: () => uploadsAllowed,
      downloadAllowed: () => true,
      takeoverTimeout: () => 42_000,
      profileDisplayName: () => "Daily browser"
    };
    const beginHumanTakeover = vi.fn(async (binding: {
      providerId: string;
      pageId: string;
      generation: number;
      owner: string;
    }) => ({ ...binding, takeoverId: "takeover-policy", startedAt: 1, expiresAt: 2 }));
    const browser = {
      id: "browser",
      running: true,
      generation: 1,
      beginHumanTakeover,
      assertHumanTakeover: () => undefined,
      currentHumanTakeover: () => undefined
    };
    const upload = vi.fn();
    const coordinator = { browserProviderId: "browser", upload, list: () => [] };
    const browserState = {
      findRecoverablePage: (_providerId: string, pageId: string) => ({
        browserProviderId: "browser",
        pageId,
        generation: 1,
        sessionId: "session-browser",
        targetId: "target-browser",
        bindingGeneration: 1,
        url: "about:blank",
        title: "Page",
        state: "open" as const,
        updatedAt: 1
      })
    };
    const store = { findOperation: () => undefined };
    const services = createConnectServices(stubApplication({
      store,
      sessionHost: immediateHost(store),
      browser,
      browserState,
      browserSettings,
      browserTransfers: coordinator
    }));
    const settingsRequest = create(contract.SubmitOperationRequestSchema, {
      operationId: "operation-browser-settings",
      connectionId: connection.id,
      mutation: create(contract.OperationMutationSchema, {
        preconditions: [],
        payload: { case: "updateBrowserSettings", value: create(contract.UpdateBrowserSettingsMutationSchema, {
          patch: create(contract.BrowserSettingsPatchSchema, {
            browserProviderId: "browser",
            enabled: false,
            allowUploads: false,
            allowDownloads: false
          })
        }) }
      })
    });

    await invoke(services.operation.submitOperation, fromBinary(
      contract.SubmitOperationRequestSchema,
      toBinary(contract.SubmitOperationRequestSchema, settingsRequest)
    ));
    expect(applied[0]).toMatchObject({ enabled: false, allowUploads: false, allowDownloads: false });

    await invoke(services.operation.submitOperation, {
      operationId: "operation-browser-takeover-ttl",
      connectionId: connection.id,
      mutation: create(contract.OperationMutationSchema, {
        preconditions: [],
        payload: { case: "beginBrowserTakeover", value: create(contract.BeginBrowserTakeoverMutationSchema, {
          browserProviderId: "browser",
          pageId: "page-1"
        }) }
      })
    });
    expect(beginHumanTakeover).toHaveBeenCalledWith({
      providerId: "browser",
      pageId: "page-1",
      generation: 1,
      owner: connection.id
    }, 42_000);

    const uploadMutation = create(contract.OperationMutationSchema, {
      preconditions: [],
      payload: { case: "uploadBrowserFile", value: create(contract.UploadBrowserFileMutationSchema, {
        browserProviderId: "browser",
        pageId: "page-1",
        inputHint: "input[type=file]",
        blob: create(contract.BlobRefSchema, {
          blobId: "blob-policy",
          mediaType: "text/plain",
          byteSize: 1n,
          sha256Hex: "a".repeat(64)
        })
      }) }
    });
    await expect(invoke(services.operation.submitOperation, {
      operationId: "operation-browser-upload-denied",
      connectionId: connection.id,
      mutation: uploadMutation
    })).rejects.toMatchObject({ code: Code.FailedPrecondition });
    expect(upload).not.toHaveBeenCalled();
  });

  it("durably commits the semantic-index preference before changing the embedding worker", async () => {
    const order: string[] = [];
    const store = {
      findOperation: () => undefined,
      setSetting: (_scope: string, _scopeId: string, key: string, value: contract.MessageSearchSettingsPatch) => {
        order.push("commit");
        expect(key).toBe("settings.message_search");
        expect(value.semanticIndexEnabled).toBe(false);
      }
    };
    const messageSearch = {
      setEnabled: vi.fn((enabled: boolean) => {
        order.push("worker");
        expect(enabled).toBe(false);
      })
    };
    const services = createConnectServices(stubApplication({
      store,
      sessionHost: immediateHost(store),
      messageSearch
    }));

    await invoke(services.operation.submitOperation, {
      operationId: "operation-message-search-settings",
      connectionId: connection.id,
      mutation: create(contract.OperationMutationSchema, {
        preconditions: [],
        payload: {
          case: "updateMessageSearchSettings",
          value: create(contract.UpdateMessageSearchSettingsMutationSchema, {
            patch: create(contract.MessageSearchSettingsPatchSchema, { semanticIndexEnabled: false })
          })
        }
      })
    });

    expect(order).toEqual(["commit", "worker"]);
    expect(messageSearch.setEnabled).toHaveBeenCalledOnce();

    const replayServices = createConnectServices(stubApplication({
      store,
      sessionHost: {
        mutate: async (input: { operationId: string; kind: string; body: unknown }) => ({
          replayed: true,
          value: { accepted: true, resultCase: "settings" },
          operation: completedRecord(
            input.operationId,
            input.kind,
            input.body,
            { accepted: true, resultCase: "settings" }
          )
        })
      },
      messageSearch
    }));
    await invoke(replayServices.operation.submitOperation, {
      operationId: "operation-message-search-settings",
      connectionId: connection.id,
      mutation: create(contract.OperationMutationSchema, {
        preconditions: [],
        payload: {
          case: "updateMessageSearchSettings",
          value: create(contract.UpdateMessageSearchSettingsMutationSchema, {
            patch: create(contract.MessageSearchSettingsPatchSchema, { semanticIndexEnabled: false })
          })
        }
      })
    });
    expect(order).toEqual(["commit", "worker", "worker"]);
    expect(messageSearch.setEnabled).toHaveBeenCalledTimes(2);
  });

  it("rejects an unavailable semantic-index enable before persisting the preference", async () => {
    const setSetting = vi.fn();
    const store = {
      findOperation: () => undefined,
      setSetting
    };
    const messageSearch = {
      available: vi.fn(() => false),
      setEnabled: vi.fn()
    };
    const services = createConnectServices(stubApplication({
      store,
      sessionHost: immediateHost(store),
      messageSearch
    }));

    await expect(invoke(services.operation.submitOperation, {
      operationId: "operation-message-search-unavailable-enable",
      connectionId: connection.id,
      mutation: create(contract.OperationMutationSchema, {
        preconditions: [],
        payload: {
          case: "updateMessageSearchSettings",
          value: create(contract.UpdateMessageSearchSettingsMutationSchema, {
            patch: create(contract.MessageSearchSettingsPatchSchema, { semanticIndexEnabled: true })
          })
        }
      })
    })).rejects.toMatchObject({ code: Code.FailedPrecondition });

    expect(messageSearch.available).toHaveBeenCalledOnce();
    expect(setSetting).not.toHaveBeenCalled();
    expect(messageSearch.setEnabled).not.toHaveBeenCalled();
  });

  it("restores semantic indexing by deleting the override before reconciling the default", async () => {
    const order: string[] = [];
    const store = {
      findOperation: () => undefined,
      deleteSetting: (_scope: string, _scopeId: string, key: string) => {
        expect(key).toBe("settings.message_search");
        order.push("delete");
      }
    };
    const messageSearch = {
      available: vi.fn(() => false),
      setEnabled: vi.fn((enabled: boolean) => {
        expect(enabled).toBe(true);
        order.push("worker");
      })
    };
    const services = createConnectServices(stubApplication({
      store,
      sessionHost: immediateHost(store),
      messageSearch
    }));

    await invoke(services.operation.submitOperation, {
      operationId: "operation-message-search-reset",
      connectionId: connection.id,
      mutation: create(contract.OperationMutationSchema, {
        preconditions: [],
        payload: {
          case: "updateMessageSearchSettings",
          value: create(contract.UpdateMessageSearchSettingsMutationSchema, {
            patch: create(contract.MessageSearchSettingsPatchSchema, { resetSemanticIndexEnabled: true })
          })
        }
      })
    });

    expect(order).toEqual(["delete", "worker"]);
    expect(messageSearch.available).not.toHaveBeenCalled();
  });

  it("restores prompt recommendations by deleting the durable override", async () => {
    const deleteSetting = vi.fn();
    const store = { findOperation: () => undefined, deleteSetting };
    const services = createConnectServices(stubApplication({
      store,
      sessionHost: immediateHost(store)
    }));

    await invoke(services.operation.submitOperation, {
      operationId: "operation-prompt-recommendation-reset",
      connectionId: connection.id,
      mutation: create(contract.OperationMutationSchema, {
        preconditions: [],
        payload: {
          case: "updatePromptRecommendationSettings",
          value: create(contract.UpdatePromptRecommendationSettingsMutationSchema, {
            patch: create(contract.PromptRecommendationSettingsPatchSchema, { resetEnabled: true })
          })
        }
      })
    });

    expect(deleteSetting).toHaveBeenCalledWith("service", "orchestrator", "settings.prompt_recommendation");
  });

  it("restores optional personalization defaults while their runtime owners are absent", async () => {
    const deleteSetting = vi.fn();
    const store = { findOperation: () => undefined, deleteSetting };
    const services = createConnectServices(stubApplication({
      store,
      sessionHost: immediateHost(store)
    }));
    const submit = async (operationId: string, payload: contract.OperationMutation["payload"]): Promise<void> => {
      await invoke(services.operation.submitOperation, {
        operationId,
        connectionId: connection.id,
        mutation: create(contract.OperationMutationSchema, { preconditions: [], payload })
      });
    };

    await submit("operation-memory-defaults-without-owner", {
      case: "updateMemorySettings",
      value: create(contract.UpdateMemorySettingsMutationSchema, { restoreDefaults: true })
    });
    await submit("operation-vision-defaults-without-owner", {
      case: "updateVisionBridgeSettings",
      value: create(contract.UpdateVisionBridgeSettingsMutationSchema, {
        patch: create(contract.VisionBridgeSettingsPatchSchema, { resetAll: true })
      })
    });

    expect(deleteSetting).toHaveBeenCalledWith("service", "orchestrator", "settings.memory");
    expect(deleteSetting).toHaveBeenCalledWith("service", "orchestrator", "settings.vision_bridge");
  });

  it("persists Vision Bridge model routes without collapsing equal Provider and model IDs across Backends", async () => {
    const setSetting = vi.fn();
    const model = {
      providerId: "shared-provider",
      modelId: "shared-vision",
      displayName: "Shared vision",
      api: "openai-responses",
      contextWindow: 128_000,
      maxOutputTokens: 16_000,
      supportsImages: true,
      thinkingLevels: [],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    };
    const backend = (id: string) => ({
      descriptor: {
        id,
        capabilities: new Map([[
          "provider.managed_catalog",
          { key: "provider.managed_catalog", supported: true }
        ]]),
        models: [model]
      }
    });
    const store = {
      findOperation: () => undefined,
      findSetting: () => undefined,
      listBackends: () => [backend("backend-a"), backend("backend-b")],
      setSetting
    };
    const services = createConnectServices(stubApplication({
      store,
      sessionHost: immediateHost(store),
      visionBridge: {},
      providers: {
        hasInferenceModel: (providerId: string, modelId: string) =>
          providerId === model.providerId && modelId === model.modelId,
        resolveInferenceRoute: () => undefined
      },
      refreshPiGeneration: vi.fn(async () => undefined)
    }));

    await invoke(services.operation.submitOperation, {
      operationId: "operation-vision-routes-by-backend",
      connectionId: connection.id,
      mutation: create(contract.OperationMutationSchema, {
        preconditions: [],
        payload: {
          case: "updateVisionBridgeSettings",
          value: create(contract.UpdateVisionBridgeSettingsMutationSchema, {
            patch: create(contract.VisionBridgeSettingsPatchSchema, {
              enabled: true,
              targetModels: create(contract.ModelRouteRefListSchema, {
                values: [
                  create(contract.ModelRouteRefSchema, {
                    backendId: "backend-b",
                    providerId: model.providerId,
                    modelId: model.modelId
                  }),
                  create(contract.ModelRouteRefSchema, {
                    backendId: "backend-a",
                    providerId: model.providerId,
                    modelId: model.modelId
                  })
                ]
              }),
              primary: create(contract.ModelRouteRefSchema, {
                backendId: "backend-b",
                providerId: model.providerId,
                modelId: model.modelId
              })
            })
          })
        }
      })
    });

    expect(setSetting).toHaveBeenCalledWith("service", "orchestrator", "settings.vision_bridge", {
      enabled: true,
      targetModels: [
        { backendId: "backend-a", providerId: model.providerId, modelId: model.modelId },
        { backendId: "backend-b", providerId: model.providerId, modelId: model.modelId }
      ],
      primary: { backendId: "backend-b", providerId: model.providerId, modelId: model.modelId }
    });
  });

  it("replays an accepted semantic-index enable after Provider availability is lost", async () => {
    const setSetting = vi.fn();
    const store = {
      findOperation: () => undefined,
      setSetting
    };
    let providerAvailable = true;
    const messageSearch = {
      available: vi.fn(() => providerAvailable),
      setEnabled: vi.fn()
    };
    const mutation = create(contract.OperationMutationSchema, {
      preconditions: [],
      payload: {
        case: "updateMessageSearchSettings",
        value: create(contract.UpdateMessageSearchSettingsMutationSchema, {
          patch: create(contract.MessageSearchSettingsPatchSchema, { semanticIndexEnabled: true })
        })
      }
    });
    const initialServices = createConnectServices(stubApplication({
      store,
      sessionHost: immediateHost(store),
      messageSearch
    }));

    await invoke(initialServices.operation.submitOperation, {
      operationId: "operation-message-search-enable-replay",
      connectionId: connection.id,
      mutation
    });
    expect(setSetting).toHaveBeenCalledOnce();
    expect(messageSearch.setEnabled).toHaveBeenCalledOnce();

    providerAvailable = false;
    const replayServices = createConnectServices(stubApplication({
      store,
      sessionHost: {
        mutate: async (input: { operationId: string; kind: string; body: unknown }) => ({
          replayed: true,
          value: { accepted: true, resultCase: "settings" },
          operation: completedRecord(
            input.operationId,
            input.kind,
            input.body,
            { accepted: true, resultCase: "settings" }
          )
        })
      },
      messageSearch
    }));

    await expect(invoke(replayServices.operation.submitOperation, {
      operationId: "operation-message-search-enable-replay",
      connectionId: connection.id,
      mutation
    })).resolves.toBeDefined();
    expect(setSetting).toHaveBeenCalledOnce();
    expect(messageSearch.available).toHaveBeenCalledOnce();
    expect(messageSearch.setEnabled).toHaveBeenCalledTimes(2);
    expect(messageSearch.setEnabled).toHaveBeenLastCalledWith(true);
  });

  it("lists only owning-Adapter native sessions and projects durable product bindings", async () => {
    const target = {
      descriptor: {
        id: "target-native",
        backendId: "pi",
        displayName: "Native workspace",
        workspaceRoot: "D:\\workspace",
        managed: false,
        trusted: true
      },
      state: "available",
      createdAt: 1,
      updatedAt: 1,
      revision: 1n
    };
    const store = {
      getTarget: () => target,
      getBackend: () => ({
        descriptor: {
          capabilities: new Map([
            ["session.discovery", { key: "session.discovery", supported: true }],
            ["session.resume", { key: "session.resume", supported: false, reason: "upstream_missing" }]
          ])
        }
      }),
      findLiveSessionByNativeBinding: (_backendId: string, nativeReference: string) => nativeReference.endsWith("bound.jsonl")
        ? { descriptor: { id: "session-bound" } }
        : undefined
    };
    const listNativeSessions = vi.fn(async () => [{
      nativeReference: "D:\\managed\\bound.jsonl",
      nativeSessionId: "native-bound",
      name: "Recovered task",
      workspaceRoot: "D:\\untrusted-jsonl-cwd",
      messageCount: 7,
      modifiedAt: 2_000,
      state: "ready" as const
    }]);
    const services = createConnectServices(stubApplication({
      store,
      sessionHost: { listNativeSessions }
    }));

    const listed = await invoke<{ sessions: contract.NativeSessionCandidate[]; page?: contract.PageInfo }>(
      services.session.discoverNativeSessions,
      { targetId: "target-native" }
    );
    const decoded = fromBinary(
      contract.DiscoverNativeSessionsResponseSchema,
      toBinary(contract.DiscoverNativeSessionsResponseSchema, create(contract.DiscoverNativeSessionsResponseSchema, listed))
    );
    expect(decoded.sessions[0]).toMatchObject({
      nativeSessionId: "native-bound",
      nativeReference: "D:\\managed\\bound.jsonl",
      workspaceRoot: "D:\\workspace",
      messageCount: 7n,
      state: contract.NativeSessionCandidateState.READY,
      boundSessionId: "session-bound"
    });

    expect(listNativeSessions).toHaveBeenCalledExactlyOnceWith("target-native");
  });

  it("maps unsupported native discovery to Unimplemented without calling the Adapter", async () => {
    const listNativeSessions = vi.fn();
    const services = createConnectServices(stubApplication({
      store: {
        getTarget: () => ({ descriptor: { id: "target-minimal", backendId: "minimal" } }),
        getBackend: () => ({
          descriptor: {
            capabilities: new Map([
              ["session.discovery", { key: "session.discovery", supported: false, reason: "upstream_missing" }],
              ["session.resume", { key: "session.resume", supported: true }]
            ])
          }
        })
      },
      sessionHost: { listNativeSessions }
    }));

    await expect(invoke(services.session.discoverNativeSessions, { targetId: "target-minimal" }))
      .rejects.toMatchObject({ code: Code.Unimplemented });
    expect(listNativeSessions).not.toHaveBeenCalled();
  });

  it("projects catalog paths separately and reports rejected and existing tasks", async () => {
    const workspaceRoot = resolve("workspace");
    const listTargets = vi.fn(() => [
      {
        descriptor: {
          id: "target-archived",
          backendId: "codex",
          displayName: "Archived project",
          workspaceRoot,
          managed: false,
          trusted: true
        },
        metadata: { state: "archived" }
      },
      {
        descriptor: {
          id: "target-deleted",
          backendId: "codex",
          displayName: "Deleted project",
          workspaceRoot,
          managed: false,
          trusted: true
        },
        metadata: { state: "active", deletedAt: 2_000 }
      },
      {
        descriptor: {
          id: "target-active",
          backendId: "codex",
          displayName: "Active project",
          workspaceRoot,
          managed: false,
          trusted: true
        },
        metadata: { state: "active" }
      }
    ]);
    const scanNativeSessionCatalogSnapshot = vi.fn(async () => ({
      token: "catalog-snapshot-token",
      existingCount: 1,
      result: {
        entries: [
        {
          nativeReference: "opaque-native-reference",
          nativeSessionId: "native-dialogue",
          title: "Recovered dialogue",
          workingDirectory: workspaceRoot,
          createdAt: 1_000,
          modifiedAt: 3_000,
          archived: true,
          placement: "dialogue" as const,
          existingMatch: "binding_and_placement" as const
        }
        ],
        rejectedCount: 9
      }
    }));
    const findLiveSessionByNativeBinding = vi.fn((_backendId: string, nativeReference: string) =>
      nativeReference === "opaque-native-reference"
        ? { descriptor: { id: "session-project", projectId: "target-active" } }
        : nativeReference === "opaque-bound-reference"
          ? { descriptor: { id: "session-bound" } }
          : undefined);
    const services = createConnectServices(stubApplication({
      store: {
        getBackend: () => ({ descriptor: { capabilities: new Map([["session.catalog", { key: "session.catalog", supported: true }]]) } }),
        listTargets,
        findLiveSessionByNativeBinding
      },
      sessionHost: { scanNativeSessionCatalogSnapshot }
    }));

    const scanned = await invoke<contract.ScanNativeSessionCatalogResponse>(
      services.session.scanNativeSessionCatalog,
      { backendId: "codex", force: true }
    );

    expect(scanned).toMatchObject({
      rejectedCount: 9n,
      existingCount: 1n,
      snapshotToken: "catalog-snapshot-token",
      entries: [{
        placement: contract.NativeSessionPlacement.DIALOGUE,
        targetId: "target-active",
        nativeSessionId: "native-dialogue",
        nativeReference: "opaque-native-reference",
        workingDirectory: workspaceRoot,
        createdAt: { seconds: 1n, nanos: 0 },
        archived: true,
        existingSessionId: "session-project"
      }]
    });
    expect(scanned.entries).toHaveLength(1);
    expect(scanNativeSessionCatalogSnapshot).toHaveBeenCalledExactlyOnceWith("codex", true);
    expect(listTargets).toHaveBeenCalledExactlyOnceWith("codex");
    expect(findLiveSessionByNativeBinding).toHaveBeenCalledOnce();
  });

  it("preserves native tree parents, previews, and Pi-compatible message roles", async () => {
    const services = createConnectServices(stubApplication({
      store: {
        getSession: () => ({
          descriptor: { id: "session-tree", backendId: "pi", targetId: "target-tree" },
          revision: 9n
        })
      },
      sessionHost: {
        getTree: async () => ({
          leafId: "tool-entry",
          roots: [{
            entryId: "user-entry",
            kind: "message",
            role: "user",
            label: "user preview",
            timestamp: 1,
            children: [{
              entryId: "assistant-entry",
              parentId: "user-entry",
              kind: "message",
              role: "assistant",
              label: "assistant preview",
              timestamp: 2,
              children: [{
                entryId: "tool-entry",
                parentId: "assistant-entry",
                kind: "message",
                role: "toolResult",
                label: "[read] tool preview",
                timestamp: 3,
                children: [{
                  entryId: "custom-entry",
                  parentId: "tool-entry",
                  kind: "custom_message",
                  role: "custom",
                  label: "custom preview",
                  timestamp: 4,
                  children: []
                }]
              }]
            }]
          }]
        })
      }
    }));

    const response = await invoke<contract.GetNativeSessionTreeResponse>(
      services.session.getNativeSessionTree,
      { sessionId: "session-tree" }
    );
    const responseRoots = contract.nativeSessionTreeRoots(response.tree!);
    expect(responseRoots[0]?.childCount).toBe(0);
    expect(responseRoots[0]?.children[0]?.childCount).toBe(0);
    const wire = fromBinary(
      contract.GetNativeSessionTreeResponseSchema,
      toBinary(contract.GetNativeSessionTreeResponseSchema, create(contract.GetNativeSessionTreeResponseSchema, response))
    );
    const root = contract.nativeSessionTreeRoots(wire.tree!)[0];
    expect(root).toMatchObject({
      entryId: "user-entry",
      parentEntryId: "",
      kind: contract.NativeEntryKind.USER_MESSAGE,
      summary: "user preview",
      active: false
    });
    expect(root?.children[0]).toMatchObject({
      entryId: "assistant-entry",
      parentEntryId: "user-entry",
      kind: contract.NativeEntryKind.ASSISTANT_MESSAGE,
      summary: "assistant preview"
    });
    expect(root?.children[0]?.children[0]).toMatchObject({
      entryId: "tool-entry",
      parentEntryId: "assistant-entry",
      kind: contract.NativeEntryKind.TOOL_RESULT,
      active: true
    });
    expect(root?.children[0]?.children[0]?.children[0]?.kind).toBe(contract.NativeEntryKind.CUSTOM);
  });

  it("projects and counts a 10001-node linear Session tree without recursive stack growth", { timeout: 20_000 }, async () => {
    const treeRoot = linearSessionTree(10_001);
    const services = createConnectServices(stubApplication({
      store: {
        getSession: () => ({
          descriptor: {
            id: "session-deep-tree",
            backendId: "pi",
            targetId: "target-tree",
            binding: { opaqueRef: "opaque:deep-tree", nativeSessionId: "native-deep-tree", generation: 1 }
          },
          revision: 9n
        }),
        findSetting: () => undefined,
        listEvents: () => [],
        sumRunActiveDuration: () => 0
      },
      sessionHost: { getTree: async () => ({ roots: [treeRoot], leafId: "tree-entry-10000" }) }
    }));

    const native = await invoke<contract.GetNativeSessionTreeResponse>(
      services.session.getNativeSessionTree,
      { sessionId: "session-deep-tree" }
    );
    const pi = await invoke<contract.GetPiSessionTreeResponse>(
      services.pi.getPiSessionTree,
      { sessionId: "session-deep-tree" }
    );
    const statistics = await invoke<contract.GetSessionStatisticsResponse>(
      services.session.getSessionStatistics,
      { sessionId: "session-deep-tree" }
    );

    const nativeWire = fromBinary(
      contract.GetNativeSessionTreeResponseSchema,
      toBinary(
        contract.GetNativeSessionTreeResponseSchema,
        create(contract.GetNativeSessionTreeResponseSchema, native)
      )
    );
    const piWire = fromBinary(
      contract.GetPiSessionTreeResponseSchema,
      toBinary(
        contract.GetPiSessionTreeResponseSchema,
        create(contract.GetPiSessionTreeResponseSchema, pi)
      )
    );
    expect(nativeWire.tree?.flatNodes).toHaveLength(10_001);
    expect(piWire.tree?.flatNodes).toHaveLength(10_001);
    const nativeRoots = contract.nativeSessionTreeRoots(nativeWire.tree!);
    const piRoots = contract.piSessionTreeRoots(piWire.tree!);
    expect(linearTreeDepth(nativeRoots[0])).toBe(10_001);
    expect(linearTreeDepth(piRoots[0])).toBe(10_001);
    expect(statistics.statistics?.branchCount).toBe(10_001n);
    expect(piRoots[0]?.children[0]?.entryId).toBe("tree-entry-1");
  });

  it("fails malformed cyclic Session tree projection without hanging", async () => {
    const children: SessionTreeNode[] = [];
    const cyclic: SessionTreeNode = {
      entryId: "cyclic-entry",
      kind: "message",
      role: "user",
      timestamp: 1,
      children
    };
    children.push(cyclic);
    const services = createConnectServices(stubApplication({
      store: {
        getSession: () => ({
          descriptor: {
            id: "session-cyclic-tree",
            backendId: "pi",
            targetId: "target-tree",
            binding: { opaqueRef: "opaque:cyclic-tree", generation: 1 }
          },
          revision: 1n
        })
      },
      sessionHost: { getTree: async () => ({ roots: [cyclic] }) }
    }));

    await expect(invoke(services.session.getNativeSessionTree, { sessionId: "session-cyclic-tree" }))
      .rejects.toThrow(/cycle or repeated/u);
    await expect(invoke(services.pi.getPiSessionTree, { sessionId: "session-cyclic-tree" }))
      .rejects.toThrow(/cycle or repeated/u);
  });

  it("returns Pi state only from one complete live observation with explicit freshness", async () => {
    const binding = {
      opaqueRef: "D:\\service-secret\\sessions\\native-live.jsonl",
      nativeSessionId: "native-live",
      generation: 7
    };
    const state: NativeSessionState = {
      binding,
      name: "Observed task",
      streaming: false,
      compacting: false,
      pendingMessages: 1,
      providerId: "provider",
      modelId: "model",
      effort: "medium",
      fastMode: false,
      permissionMode: "ask",
      pi: {
        nativeSessionId: "native-live",
        nativeSessionName: "Observed task",
        nativeSessionFileDisplay: "native-live.jsonl",
        model: { providerId: "provider", modelId: "model" },
        thinkingLevel: "medium",
        streaming: false,
        compacting: false,
        steeringMode: "all",
        followUpMode: "one_at_a_time",
        autoCompaction: true,
        autoRetry: false,
        messageCount: 8,
        pendingMessageCount: 1,
        activeLeafId: "leaf-8"
      }
    };
    const observation = nativeStateObservation(state, state.pi, 1_234);
    const store = {
      getSession: () => ({
        descriptor: { id: "session-live", backendId: "pi", targetId: "target", binding },
        revision: 1n
      }),
      findSetting: (scope: string, owner: string, key: string) => {
        expect([scope, owner, key]).toEqual(["session", "session-live", SESSION_NATIVE_STATE_OBSERVATION_SETTING_KEY]);
        return { value: observation };
      }
    };
    const services = createConnectServices(stubApplication({
      store,
      sessionHost: { inspect: async () => state }
    }));

    const response = await invoke<contract.GetPiSessionStateResponse>(
      services.pi.getPiSessionState,
      { sessionId: "session-live" }
    );
    const wire = fromBinary(
      contract.GetPiSessionStateResponseSchema,
      toBinary(contract.GetPiSessionStateResponseSchema, response)
    );
    expect(wire.state).toMatchObject({
      nativeSessionId: "native-live",
      nativeSessionFileDisplay: "native-live.jsonl",
      autoRetry: false,
      activeLeafId: "leaf-8",
      messageCount: 8n
    });
    expect(wire.observation).toMatchObject({
      source: contract.PiStateObservationSource.LIVE_RPC,
      completeness: contract.PiStateObservationCompleteness.COMPLETE,
      runtimeGeneration: 7n,
      bindingCurrent: true
    });
    expect(Buffer.from(toBinary(contract.GetPiSessionStateResponseSchema, wire)).toString("utf8"))
      .not.toContain("service-secret");
  });

  it("maps adapter-owned ID-less Pi message projections across every public role without leaking arguments", async () => {
    const agentHome = mkdtempSync(join(tmpdir(), "joko-pi-message-map-"));
    cleanupPaths.push(agentHome);
    const adapter = new PiBackendAdapter({ agentHome, sessionRoot: join(agentHome, "sessions") });
    const ingestBytes = vi.fn(async (bytes: Uint8Array, options: { mimeType: string; fileName: string }) => ({
      id: "pi-image-blob",
      sha256: createHash("sha256").update(bytes).digest("hex"),
      byteLength: bytes.byteLength,
      mimeType: options.mimeType,
      fileName: options.fileName,
      storagePath: "pi-image-blob",
      createdAt: 1
    }));
    vi.spyOn(adapter, "getMessages").mockResolvedValue([
      {
        id: "joko:pi-message:user:0",
        role: "user",
        content: [{ type: "text", text: "question" }, { type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
        timestamp: 1
      },
      {
        id: "joko:pi-message:assistant:0",
        role: "assistant",
        content: [
          { type: "thinking", thinking: "reasoning", redacted: false },
          { type: "toolCall", id: "tool-1", name: "read", arguments: { path: "\"README.md\"", apiKey: "[REDACTED]" } }
        ],
        timestamp: 2,
        usage: { input: 3, output: 4, cacheRead: 1, cacheWrite: 2, totalTokens: 10, costMicros: 123 }
      },
      {
        id: "joko:pi-message:tool:0",
        role: "toolResult",
        content: [{ type: "text", text: "result" }],
        toolCallId: "tool-1",
        toolName: "read",
        isError: false,
        timestamp: 3
      },
      { id: "joko:pi-message:custom:0", role: "custom", content: [{ type: "text", text: "custom" }], timestamp: 4 }
    ]);
    const services = createConnectServices(stubApplication({
      artifacts: { maximumBlobBytes: 256 * 1024 * 1024, ingestBytes },
      sessionHost: {
        invokeAdapter: async (
          _sessionId: string,
          callback: (value: PiBackendAdapter, adapterContext: never) => Promise<unknown>
        ) => callback(adapter, {} as never)
      }
    }));

    const response = await invoke<contract.ListPiMessagesResponse>(services.pi.listPiMessages, {
      sessionId: "session-message-map",
      page: { pageSize: 100, pageToken: "" }
    });
    await adapter.dispose();
    const typedResponse = create(contract.ListPiMessagesResponseSchema, response);
    const wire = fromBinary(
      contract.ListPiMessagesResponseSchema,
      toBinary(contract.ListPiMessagesResponseSchema, typedResponse)
    );

    expect(wire.messages.map((message) => message.role)).toEqual([
      contract.PiMessageRole.USER,
      contract.PiMessageRole.ASSISTANT,
      contract.PiMessageRole.TOOL_RESULT,
      contract.PiMessageRole.CUSTOM
    ]);
    expect(wire.messages.map((message) => message.nativeMessageId)).toEqual([
      "joko:pi-message:user:0",
      "joko:pi-message:assistant:0",
      "joko:pi-message:tool:0",
      "joko:pi-message:custom:0"
    ]);
    expect(wire.messages.every((message) => message.nativeEntryId === "")).toBe(true);
    expect(wire.messages[1]?.usage).toMatchObject({ totalTokens: 10n, costMicros: 123n });
    expect(wire.messages[1]?.parts[1]?.content).toMatchObject({
      case: "toolCall",
      value: {
        nativeToolCallId: "tool-1",
        toolName: "read",
        arguments: [
          expect.objectContaining({ fieldPath: "path", value: { case: "text", value: "\"README.md\"" }, redacted: false }),
          expect.objectContaining({ fieldPath: "apiKey", value: { case: "text", value: "" }, redacted: true })
        ]
      }
    });
    expect(wire.messages[0]?.parts[1]?.content).toMatchObject({
      case: "image",
      value: { blob: { blobId: "pi-image-blob", byteSize: 5n, mediaType: "image/png" } }
    });
    expect(wire.messages[2]?.parts[0]?.content).toMatchObject({
      case: "toolResult",
      value: {
        nativeToolCallId: "tool-1",
        toolName: "read",
        error: false,
        result: { parts: [{ content: { case: "text", value: "result" } }] }
      }
    });
    expect(ingestBytes).toHaveBeenCalledOnce();
    expect(Buffer.from(toBinary(contract.ListPiMessagesResponseSchema, wire)).toString("utf8"))
      .not.toContain("[REDACTED]");
  });

  it("pages the stable Pi message projection before mapping every formerly capped part and argument", async () => {
    const agentHome = mkdtempSync(join(tmpdir(), "joko-pi-complete-panel-map-"));
    cleanupPaths.push(agentHome);
    const adapter = new PiBackendAdapter({ agentHome, sessionRoot: join(agentHome, "sessions") });
    const longText = "t".repeat(65_537);
    const longArgument = "a".repeat(4_097);
    const arguments_ = Object.fromEntries(Array.from({ length: 65 }, (_, index) => [
      index === 0 ? "apiKey" : `argument-${index}`,
      index === 0 ? "[REDACTED]" : index === 64 ? longArgument : `value-${index}`
    ]));
    const messages = [
      ...Array.from({ length: 10_000 }, (_, index) => ({
        id: `joko:pi-message:${index}`,
        role: "user" as const,
        content: [{ type: "text" as const, text: `message-${index}` }],
        timestamp: index
      })),
      {
        id: "joko:pi-message:10000",
        role: "assistant" as const,
        content: [
          { type: "text" as const, text: longText },
          ...Array.from({ length: 127 }, (_, index) => ({ type: "text" as const, text: `part-${index + 1}` })),
          { type: "toolCall" as const, id: "complete-call", name: "complete_tool", arguments: arguments_ }
        ],
        timestamp: 10_000
      }
    ];
    vi.spyOn(adapter, "getMessages").mockResolvedValue(messages);
    const services = createConnectServices(stubApplication({
      sessionHost: {
        invokeAdapter: async (
          _sessionId: string,
          callback: (value: PiBackendAdapter, adapterContext: never) => Promise<unknown>
        ) => callback(adapter, {} as never)
      }
    }));

    const response = await invoke<contract.ListPiMessagesResponse>(services.pi.listPiMessages, {
      sessionId: "session-complete-panel-map",
      page: {
        pageSize: 2,
        pageToken: Buffer.from("joko-page:9999", "utf8").toString("base64url")
      }
    });
    await adapter.dispose();

    expect(response.page).toMatchObject({ totalSize: 10_001n, nextPageToken: "" });
    expect(response.messages.map((message) => message.nativeMessageId)).toEqual([
      "joko:pi-message:9999",
      "joko:pi-message:10000"
    ]);
    expect(response.messages[1]?.parts).toHaveLength(129);
    expect(response.messages[1]?.parts[0]?.content).toEqual({ case: "text", value: longText });
    const toolCall = response.messages[1]?.parts[128]?.content;
    expect(toolCall).toMatchObject({ case: "toolCall", value: { arguments: expect.any(Array) } });
    if (toolCall?.case !== "toolCall") throw new Error("Expected a complete tool-call projection.");
    expect(toolCall.value.arguments).toHaveLength(65);
    expect(toolCall.value.arguments.find((item) => item.fieldPath === "argument-64")?.value)
      .toEqual({ case: "text", value: longArgument });
    expect(toolCall.value.arguments.find((item) => item.fieldPath === "apiKey"))
      .toMatchObject({ redacted: true, value: { case: "text", value: "" } });
  });

  it("pages Pi entries before creating one complete sanitized custom-payload Artifact", async () => {
    const agentHome = mkdtempSync(join(tmpdir(), "joko-pi-custom-entry-map-"));
    cleanupPaths.push(agentHome);
    const adapter = new PiBackendAdapter({ agentHome, sessionRoot: join(agentHome, "sessions") });
    const patternSecret = "sk-abcdefghijklmnop";
    vi.spyOn(adapter, "getEntries").mockResolvedValue({
      entries: [
        { id: "custom-0", parentId: null, type: "custom", payload: { value: "not selected" } },
        { id: "custom-1", parentId: "custom-0", type: "custom", payload: { value: `visible ${patternSecret}`, complete: "x".repeat(1_024) } }
      ],
      leafId: "custom-1"
    });
    const storedPayloads: string[] = [];
    const ingestBytes = vi.fn(async (bytes: Uint8Array, options: { mimeType: string; fileName: string }) => {
      storedPayloads.push(Buffer.from(bytes).toString("utf8"));
      return {
        id: "custom-payload-artifact",
        sha256: createHash("sha256").update(bytes).digest("hex"),
        byteLength: bytes.byteLength,
        mimeType: options.mimeType,
        fileName: options.fileName,
        storagePath: "custom-payload-artifact",
        createdAt: 1
      };
    });
    const services = createConnectServices(stubApplication({
      artifacts: { maximumBlobBytes: 256 * 1024 * 1024, ingestBytes },
      sessionHost: {
        invokeAdapter: async (
          _sessionId: string,
          callback: (value: PiBackendAdapter, adapterContext: never) => Promise<unknown>
        ) => callback(adapter, {} as never)
      }
    }));

    const response = await invoke<contract.ListPiEntriesResponse>(services.pi.listPiEntries, {
      sessionId: "session-custom-entry-map",
      page: {
        pageSize: 1,
        pageToken: Buffer.from("joko-page:1", "utf8").toString("base64url")
      }
    });
    await adapter.dispose();

    expect(response.page).toMatchObject({ totalSize: 2n, nextPageToken: "" });
    expect(response.entries).toHaveLength(1);
    expect(response.entries[0]?.payload).toMatchObject({
      case: "custom",
      value: { sanitizedPayloadArtifact: { blobId: "custom-payload-artifact" } }
    });
    expect(ingestBytes).toHaveBeenCalledOnce();
    expect(storedPayloads[0]).toContain('"complete":"');
    expect(storedPayloads[0]).toContain("x".repeat(1_024));
    expect(storedPayloads[0]).not.toContain(patternSecret);
  });

  it("reuses one content-addressed Artifact when the same sanitized custom entry is listed again", async () => {
    const directory = mkdtempSync(join(tmpdir(), "joko-pi-custom-entry-dedup-"));
    cleanupPaths.push(directory);
    const store = new OperationalStore(join(directory, "orchestrator.db"));
    const artifacts = new ArtifactStore({
      rootDirectory: join(directory, "artifacts"),
      repository: new OperationalArtifactRepository(store),
      ingestRoots: [directory]
    });
    await artifacts.initialize();
    const adapter = new PiBackendAdapter({
      agentHome: join(directory, "agent-home"),
      sessionRoot: join(directory, "sessions")
    });
    vi.spyOn(adapter, "getEntries").mockResolvedValue({
      entries: [{ id: "stable-custom", parentId: null, type: "custom", payload: { complete: "payload" } }],
      leafId: "stable-custom"
    });
    const services = createConnectServices(stubApplication({
      artifacts,
      sessionHost: {
        invokeAdapter: async (
          _sessionId: string,
          callback: (value: PiBackendAdapter, adapterContext: never) => Promise<unknown>
        ) => callback(adapter, {} as never)
      }
    }));
    const request = {
      sessionId: "session-custom-entry-dedup",
      page: { pageSize: 1, pageToken: "" }
    };

    try {
      const first = await invoke<contract.ListPiEntriesResponse>(services.pi.listPiEntries, request);
      const second = await invoke<contract.ListPiEntriesResponse>(services.pi.listPiEntries, request);
      const firstBlob = first.entries[0]?.payload.case === "custom"
        ? first.entries[0].payload.value.sanitizedPayloadArtifact
        : undefined;
      const secondBlob = second.entries[0]?.payload.case === "custom"
        ? second.entries[0].payload.value.sanitizedPayloadArtifact
        : undefined;
      expect(firstBlob?.blobId).toBeTruthy();
      expect(secondBlob?.blobId).toBe(firstBlob?.blobId);
      expect(store.listArtifacts({ limit: 10 })).toHaveLength(1);
    } finally {
      await adapter.dispose();
      store.close();
    }
  });

  it("materializes a Pi panel image larger than 25 MiB through the real Artifact capability", async () => {
    const directory = mkdtempSync(join(tmpdir(), "joko-pi-large-panel-image-"));
    cleanupPaths.push(directory);
    const store = new OperationalStore(join(directory, "orchestrator.db"));
    const artifacts = new ArtifactStore({
      rootDirectory: join(directory, "artifacts"),
      repository: new OperationalArtifactRepository(store),
      ingestRoots: [directory],
      maximumBlobBytes: 32 * 1024 * 1024
    });
    await artifacts.initialize();
    const adapter = new PiBackendAdapter({
      agentHome: join(directory, "agent-home"),
      sessionRoot: join(directory, "sessions")
    });
    const imageBytes = Buffer.alloc(25 * 1024 * 1024 + 1);
    imageBytes.set([0x89, 0x50, 0x4e, 0x47]);
    vi.spyOn(adapter, "getMessages").mockResolvedValue([{
      id: "joko:pi-message:large-image:0",
      role: "user",
      content: [{ type: "image", data: imageBytes.toString("base64"), mimeType: "image/png" }],
      timestamp: 1
    }]);
    const services = createConnectServices(stubApplication({
      artifacts,
      sessionHost: {
        invokeAdapter: async (
          _sessionId: string,
          callback: (value: PiBackendAdapter, adapterContext: never) => Promise<unknown>
        ) => callback(adapter, {} as never)
      }
    }));

    try {
      const response = await invoke<contract.ListPiMessagesResponse>(services.pi.listPiMessages, {
        sessionId: "session-large-panel-image",
        page: { pageSize: 100, pageToken: "" }
      });
      const image = response.messages[0]?.parts[0]?.content;
      expect(image).toMatchObject({
        case: "image",
        value: { blob: { byteSize: BigInt(imageBytes.byteLength), mediaType: "image/png" } }
      });
      expect(store.listArtifacts({ limit: 10 })).toEqual([
        expect.objectContaining({
          blob: expect.objectContaining({
            byteLength: imageBytes.byteLength,
            sha256: createHash("sha256").update(imageBytes).digest("hex"),
            mimeType: "image/png"
          })
        })
      ]);
    } finally {
      await adapter.dispose();
      store.close();
    }
  });

  it("rejects an image one byte above the Artifact ceiling before ingest", async () => {
    const agentHome = mkdtempSync(join(tmpdir(), "joko-pi-panel-image-ceiling-"));
    cleanupPaths.push(agentHome);
    const adapter = new PiBackendAdapter({ agentHome, sessionRoot: join(agentHome, "sessions") });
    const ingestBytes = vi.fn();
    vi.spyOn(adapter, "getMessages").mockResolvedValue([{
      id: "joko:pi-message:over-cap:0",
      role: "user",
      content: [{ type: "image", data: Buffer.alloc(9).toString("base64"), mimeType: "image/png" }],
      timestamp: 1
    }]);
    const services = createConnectServices(stubApplication({
      artifacts: { maximumBlobBytes: 8, ingestBytes },
      sessionHost: {
        invokeAdapter: async (
          _sessionId: string,
          callback: (value: PiBackendAdapter, adapterContext: never) => Promise<unknown>
        ) => callback(adapter, {} as never)
      }
    }));

    await expect(invoke(services.pi.listPiMessages, {
      sessionId: "session-panel-image-over-cap",
      page: { pageSize: 100, pageToken: "" }
    })).rejects.toMatchObject({ code: Code.ResourceExhausted });
    expect(ingestBytes).not.toHaveBeenCalled();
    await adapter.dispose();
  });

  it("maps persisted Pi compaction and branch-summary entries using upstream field names", async () => {
    const agentHome = mkdtempSync(join(tmpdir(), "joko-pi-entry-map-"));
    cleanupPaths.push(agentHome);
    const adapter = new PiBackendAdapter({ agentHome, sessionRoot: join(agentHome, "sessions") });
    vi.spyOn(adapter, "getEntries").mockResolvedValue({
      entries: [
        {
          id: "compaction-entry",
          parentId: "tree-parent",
          type: "compaction",
          summary: "native compacted summary",
          firstKeptEntryId: "first-kept-entry",
          tokensBefore: 7_654
        },
        {
          id: "branch-summary-entry",
          parentId: "new-branch-attachment",
          type: "branch_summary",
          fromId: "abandoned-branch-leaf",
          summary: "native branch summary"
        },
        {
          id: "model-change-entry",
          parentId: "branch-summary-entry",
          type: "model_change",
          provider: "native-provider",
          modelId: "native-model"
        }
      ],
      leafId: "branch-summary-entry"
    });
    const services = createConnectServices(stubApplication({
      sessionHost: {
        invokeAdapter: async (
          _sessionId: string,
          callback: (value: PiBackendAdapter, adapterContext: never) => Promise<unknown>
        ) => callback(adapter, {} as never)
      }
    }));

    const response = await invoke<contract.ListPiEntriesResponse>(services.pi.listPiEntries, {
      sessionId: "session-compaction",
      sinceEntryId: "",
      page: { pageSize: 100, pageToken: "" }
    });
    await adapter.dispose();
    expect(response.entries).toHaveLength(3);
    expect(response.entries[0]?.$typeName).toBe("joko.v1.PiSessionEntry");
    expect(response.entries[0]?.payload.case).toBe("compaction");
    const typedResponse = create(contract.ListPiEntriesResponseSchema, response);
    const wire = fromBinary(
      contract.ListPiEntriesResponseSchema,
      toBinary(contract.ListPiEntriesResponseSchema, typedResponse)
    );

    expect(wire.activeLeafId).toBe("branch-summary-entry");
    expect(wire.entries[0]).toMatchObject({
      entryId: "compaction-entry",
      parentId: "tree-parent",
      payload: {
        case: "compaction",
        value: {
          boundaryEntryId: "first-kept-entry",
          summary: "native compacted summary",
          tokensBefore: 7_654n,
          tokensAfter: 0n
        }
      }
    });
    expect(wire.entries[1]).toMatchObject({
      entryId: "branch-summary-entry",
      parentId: "new-branch-attachment",
      payload: {
        case: "branchSummary",
        value: {
          branchFromEntryId: "abandoned-branch-leaf",
          summary: "native branch summary"
        }
      }
    });
    expect(wire.entries[2]).toMatchObject({
      entryId: "model-change-entry",
      payload: {
        case: "modelChange",
        value: { model: { providerId: "native-provider", modelId: "native-model" } }
      }
    });
  });

  it("promotes managed resources to loaded only from an active runtime observation", async () => {
    let resource: any = {
      id: "resource-loaded",
      backendId: "pi",
      targetId: "target-1",
      kind: "skill",
      scope: "managed",
      name: "Observed skill",
      sourceKind: "local",
      sourceIdentity: "skill:observed",
      sourceDisplay: "observed-skill",
      canonicalPathFingerprint: "sha256:fingerprint",
      symbolicLinkDetected: false,
      specialFileDetected: false,
      discoveredRevision: "sha256:revision",
      resourceDetails: [],
      runtimeRequirements: [],
      warnings: [],
      disabledLifecycleScripts: [],
      canToggle: true,
      requiresExtensionApproval: false,
      postMutationNotice: false,
      state: "installed",
      enabled: true,
      versionNumber: 1n,
      updatedAt: 1
    };
    const markLoaded = vi.fn(async () => {
      resource = { ...resource, state: "loaded", versionNumber: 2n, updatedAt: 2 };
      return resource;
    });
    const services = createConnectServices(stubApplication({
      store: {},
      sessionHost: {
        observeActiveResources: async () => [{
          backendId: "pi",
          targetId: "target-1",
          sessionId: "session-current",
          generation: 7,
          resource: {
            id: "resource-loaded",
            kind: "skill",
            name: "Observed skill",
            source: "managed",
            state: "loaded",
            revision: "sha256:revision",
            resourceVersion: 1n,
            runtimeGeneration: 7
          }
        }]
      },
      piResources: {
        get: () => resource,
        markLoaded,
        list: () => [resource]
      }
    }));

    const listed = await invoke<{ resources: contract.ManagedResource[] }>(services.pi.listPiResources, {
      backendId: "pi",
      targetId: "target-1"
    });
    expect(markLoaded).toHaveBeenCalledWith("resource-loaded", true, undefined, {
      discoveredRevision: "sha256:revision",
      resourceVersion: 1n,
      sessionId: "session-current",
      runtimeGeneration: 7
    });
    expect(listed.resources[0]).toMatchObject({
      resourceId: "resource-loaded",
      state: contract.ResourceState.LOADED,
      enabled: true
    });
  });

  it("does not let an old runtime generation or old content revision promote a replacement with the same id", async () => {
    const resource = {
      id: "resource-replaced",
      backendId: "pi",
      targetId: "target-1",
      kind: "extension",
      scope: "managed",
      name: "Replaced extension",
      sourceKind: "local",
      sourceIdentity: "extension:replacement",
      sourceDisplay: "replacement",
      canonicalPathFingerprint: "sha256:fingerprint-new",
      symbolicLinkDetected: false,
      specialFileDetected: false,
      discoveredRevision: "sha256:revision-new",
      resourceDetails: [],
      runtimeRequirements: [],
      warnings: [],
      disabledLifecycleScripts: [],
      canToggle: true,
      requiresExtensionApproval: false,
      postMutationNotice: false,
      state: "installed",
      enabled: true,
      versionNumber: 9n,
      updatedAt: 9
    };
    const markLoaded = vi.fn(async () => resource);
    const services = createConnectServices(stubApplication({
      store: {},
      sessionHost: {
        observeActiveResources: async () => [{
          backendId: "pi",
          targetId: "target-1",
          sessionId: "session-old-generation",
          generation: 5,
          resource: {
            id: resource.id,
            kind: "extension",
            name: resource.name,
            source: "old runtime",
            state: "loaded",
            revision: resource.discoveredRevision,
            resourceVersion: resource.versionNumber,
            runtimeGeneration: 4
          }
        }, {
          backendId: "pi",
          targetId: "target-1",
          sessionId: "session-old-revision",
          generation: 5,
          resource: {
            id: resource.id,
            kind: "extension",
            name: resource.name,
            source: "old revision",
            state: "loaded",
            revision: "sha256:revision-old",
            resourceVersion: resource.versionNumber,
            runtimeGeneration: 5
          }
        }, {
          backendId: "pi",
          targetId: "target-1",
          sessionId: "session-old-installation",
          generation: 5,
          resource: {
            id: resource.id,
            kind: "extension",
            name: resource.name,
            source: "old installation",
            state: "loaded",
            revision: resource.discoveredRevision,
            resourceVersion: 8n,
            runtimeGeneration: 5
          }
        }]
      },
      piResources: {
        get: () => resource,
        markLoaded,
        list: () => [resource]
      }
    }));

    const listed = await invoke<{ resources: contract.ManagedResource[] }>(services.pi.listPiResources, {
      backendId: "pi",
      targetId: "target-1"
    });

    expect(markLoaded).not.toHaveBeenCalled();
    expect(listed.resources[0]?.state).toBe(contract.ResourceState.INSTALLED);
  });

  it("maps fallback resources only from already-active owning Sessions", async () => {
    const listSessions = vi.fn(() => []);
    const getResources = vi.fn(async () => []);
    const observeActiveResources = vi.fn(async () => [
      {
        backendId: "custom-alpha",
        targetId: "target-alpha",
        sessionId: "session-alpha",
        generation: 1,
        resource: {
          id: "shared-resource",
          kind: "skill" as const,
          name: "Resource for session-alpha",
          source: "source:session-alpha",
          state: "loaded" as const
        }
      },
      {
        backendId: "custom-beta",
        targetId: "target-beta",
        sessionId: "session-beta",
        generation: 1,
        resource: {
          id: "shared-resource",
          kind: "skill" as const,
          name: "Resource for session-beta",
          source: "source:session-beta",
          state: "loaded" as const
        }
      }
    ]);
    const services = createConnectServices(stubApplication({
      store: { listSessions },
      sessionHost: {
        getResources,
        observeActiveResources
      }
    }));

    const listed = await invoke<{ resources: contract.ManagedResource[] }>(services.pi.listPiResources, {
      backendId: "",
      targetId: ""
    });
    expect(listed.resources).toEqual(expect.arrayContaining([
      expect.objectContaining({
        resourceId: "shared-resource",
        backendId: "custom-alpha",
        targetId: "target-alpha"
      }),
      expect.objectContaining({
        resourceId: "shared-resource",
        backendId: "custom-beta",
        targetId: "target-beta"
      })
    ]));
    expect(listed.resources).toHaveLength(2);
    expect(observeActiveResources).toHaveBeenCalledWith({});
    expect(listSessions).not.toHaveBeenCalled();
    expect(getResources).not.toHaveBeenCalled();
  });

  it("keeps sensitive Provider login input on a flow-bound one-time upload channel", async () => {
    const pending = {
      providerId: "openai-codex",
      method: "oauth_browser" as const,
      opaqueFlowId: "native-flow-1",
      state: "pending" as const,
      startedAt: 10,
      updatedAt: 11,
      expiresAt: 60_000,
      pendingPrompt: {
        promptId: "prompt-manual-code",
        kind: "manual_code" as const,
        message: "Paste the Provider authorization code or final redirect URL.",
        placeholder: "https://localhost/callback?code=...",
        createdAt: 11
      }
    };
    let current: any = pending;
    const beginInputUpload = vi.fn(() => ({
      credentialUploadTicketId: "credential-ticket-1",
      expiresAt: 20_000,
      maximumBytes: 16_384
    }));
    const submitInput = vi.fn((input: any) => {
      expect(input.answer).toEqual({ case: "credential_upload", credentialUploadTicketId: "credential-ticket-1" });
      current = { ...pending, pendingPrompt: undefined, state: "completed", updatedAt: 12 };
      return current;
    });
    const cancel = vi.fn(() => {
      current = { ...pending, pendingPrompt: undefined, state: "cancelled", updatedAt: 13, error: "Provider login was cancelled." };
      return current;
    });
    const services = createConnectServices(stubApplication({
      providerAuth: {
        getFlow: (id: string) => id === "native-flow-1" ? current : undefined,
        beginInputUpload,
        submitInput,
        cancel
      }
    }));

    const upload = await invoke<{ ticket?: contract.CredentialUploadTicket }>(
      services.credential.beginProviderLoginInputUpload,
      { loginFlowId: "native-flow-1", promptId: "prompt-manual-code" }
    );
    expect(upload.ticket).toMatchObject({
      ticketId: "credential-ticket-1",
      relativeEndpoint: "/v1/credentials/upload/credential-ticket-1",
      maximumBytes: 16_384n
    });
    expect(beginInputUpload).toHaveBeenCalledWith({
      flowId: "native-flow-1",
      promptId: "prompt-manual-code",
      connectionId: connection.id
    });

    await expect(invoke(services.credential.submitProviderLoginInput, {
      loginFlowId: "native-flow-1",
      promptId: "prompt-manual-code",
      input: { case: "text", value: "must-not-enter-the-service-result" }
    })).rejects.toMatchObject({ code: 3 });
    expect(submitInput).not.toHaveBeenCalled();

    const submitted = await invoke<{ loginFlow?: contract.ProviderLoginFlow }>(
      services.credential.submitProviderLoginInput,
      {
        loginFlowId: "native-flow-1",
        promptId: "prompt-manual-code",
        input: { case: "credentialInputTicketId", value: "credential-ticket-1" }
      }
    );
    expect(submitted.loginFlow).toMatchObject({
      loginFlowId: "native-flow-1",
      state: contract.ProviderLoginFlowState.COMPLETED,
      pendingPrompt: undefined
    });
    const submittedWire = toBinary(contract.SubmitProviderLoginInputResponseSchema, create(
      contract.SubmitProviderLoginInputResponseSchema,
      submitted
    ));
    expect(Buffer.from(submittedWire).toString("utf8")).not.toContain("must-not-enter-the-service-result");

    current = pending;
    const cancelled = await invoke<{ loginFlow?: contract.ProviderLoginFlow }>(
      services.credential.cancelProviderLogin,
      { loginFlowId: "native-flow-1" }
    );
    expect(cancelled.loginFlow).toMatchObject({ state: contract.ProviderLoginFlowState.CANCELLED });
    expect(cancel).toHaveBeenCalledWith("native-flow-1");
  });

  it("maps an unavailable native Provider login implementation to Unimplemented", async () => {
    const store = {
      findOperation: () => undefined,
      getBackend: (backendId: string) => ({
        descriptor: {
          id: backendId,
          capabilities: new Map([["provider.managed_catalog", { key: "provider.managed_catalog", supported: true }]])
        }
      })
    };
    const application = stubApplication({
      store,
      sessionHost: immediateHost(store),
      providers: {
        beginLogin: async () => {
          throw new ProviderAuthUnsupportedError("Provider login is unavailable in the installed Pi runtime.");
        }
      }
    });
    let submitOperation: unknown;
    registerConnectServices({
      service(descriptor: unknown, implementation: Record<string, unknown>) {
        if (descriptor === contract.OperationService) submitOperation = implementation.submitOperation;
      }
    } as any, application);

    await expect(invoke(submitOperation, {
      operationId: "operation-provider-login-unsupported",
      connectionId: connection.id,
      mutation: create(contract.OperationMutationSchema, {
        preconditions: [],
        payload: {
          case: "beginProviderLogin",
          value: create(contract.BeginProviderLoginMutationSchema, {
            backendId: "managed-backend",
            providerId: "unsupported-provider",
            method: contract.ProviderLoginMethod.OAUTH_BROWSER
          })
        }
      })
    })).rejects.toMatchObject({ code: 12 });
  });

  it("maps task history scans and cancellable maintenance progress without a synchronous cleanup path", async () => {
    const scanId = "11111111-1111-4111-8111-111111111111";
    const maintenanceId = "22222222-2222-4222-8222-222222222222";
    const result = {
      activeTaskCount: 1,
      deletedTaskCount: 2,
      archivedTaskCount: 3,
      messageCount: 17,
      beforeBytes: 8_192,
      afterBytes: 2_048,
      reclaimedBytes: 6_144,
      backupCreated: true,
      skippedTaskCount: 4
    };
    const scan = vi.fn(() => ({
      scanId,
      retention: "7-days" as const,
      includeActiveTasks: true,
      scannedAt: 1_000,
      olderThan: 500,
      expiresAt: 61_000,
      activeTaskCount: 1,
      deletedTaskCount: 2,
      archivedTaskCount: 3,
      messageCount: 17,
      estimatedHistoryBytes: 4_096,
      databaseBytes: 8_192,
      temporaryBytesRequired: 16_384,
      databaseVolumeFreeBytes: 32_768
    }));
    const beginCleanup = vi.fn(() => ({
      maintenanceId,
      status: "running" as const,
      phase: "copying" as const,
      percent: 18,
      cancellable: true,
      updatedAt: 2_000
    }));
    const getCleanup = vi.fn(() => ({
      maintenanceId,
      status: "completed" as const,
      phase: "installing" as const,
      percent: 100,
      cancellable: false,
      updatedAt: 3_000,
      result
    }));
    const cancelCleanup = vi.fn(() => ({
      maintenanceId,
      status: "cancelled" as const,
      phase: "compacting" as const,
      percent: 60,
      cancellable: false,
      updatedAt: 4_000
    }));
    const services = createConnectServices(stubApplication({
      historyMaintenance: {
        supported: () => true,
        scan,
        beginCleanup,
        getCleanup,
        cancelCleanup
      }
    }));

    await expect(invoke<any>(services.historyMaintenance.getHistoryMaintenanceSupport, {}))
      .resolves.toMatchObject({ support: contract.CapabilitySupport.SUPPORTED, supportReason: "" });
    const scanned = await invoke<any>(services.historyMaintenance.scanTaskHistory, {
      retention: contract.TaskHistoryRetention.SEVEN_DAYS,
      includeActiveTasks: true
    });
    expect(scan).toHaveBeenCalledWith({ retention: "7-days", includeActiveTasks: true });
    expect(scanned.scan).toMatchObject({
      scanId,
      retention: contract.TaskHistoryRetention.SEVEN_DAYS,
      activeTaskCount: 1n,
      messageCount: 17n,
      databaseVolumeFreeBytes: 32_768n
    });

    const begun = await invoke<any>(services.historyMaintenance.beginTaskHistoryCleanup, {
      scanId,
      backupEnabled: true
    });
    expect(beginCleanup).toHaveBeenCalledWith(scanId, true);
    expect(begun.progress).toMatchObject({
      maintenanceId,
      status: contract.TaskHistoryMaintenanceStatus.RUNNING,
      phase: contract.TaskHistoryMaintenancePhase.COPYING,
      percent: 18,
      cancellable: true
    });

    const completed = await invoke<any>(services.historyMaintenance.getTaskHistoryCleanup, { maintenanceId });
    expect(completed.progress).toMatchObject({
      status: contract.TaskHistoryMaintenanceStatus.COMPLETED,
      result: { reclaimedBytes: 6_144n, backupCreated: true, skippedTaskCount: 4n }
    });
    const cancelled = await invoke<any>(services.historyMaintenance.cancelTaskHistoryCleanup, { maintenanceId });
    expect(cancelCleanup).toHaveBeenCalledWith(maintenanceId);
    expect(cancelled.progress).toMatchObject({
      status: contract.TaskHistoryMaintenanceStatus.CANCELLED,
      phase: contract.TaskHistoryMaintenancePhase.COMPACTING,
      cancellable: false
    });

    await expect(invoke(services.historyMaintenance.scanTaskHistory, {
      retention: contract.TaskHistoryRetention.UNSPECIFIED,
      includeActiveTasks: false
    })).rejects.toMatchObject({ code: Code.InvalidArgument });
    await expect(invoke(services.historyMaintenance.beginTaskHistoryCleanup, {
      scanId: "------------------------------------",
      backupEnabled: false
    })).rejects.toMatchObject({ code: Code.InvalidArgument });
  });

  it("previews an integrity-checked inverse diff and executes dialogue-only rewind without restoring files", async () => {
    const directory = mkdtempSync(join(tmpdir(), "joko-connect-dialogue-rewind-"));
    cleanupPaths.push(directory);
    const snapshotPath = join(directory, "after.txt");
    const contents = Buffer.from("after\n", "utf8");
    writeFileSync(snapshotPath, contents);
    const changeSet = {
      id: "change-set-dialogue",
      baselineId: "baseline-dialogue",
      workspaceId: "workspace-dialogue",
      workspaceRoot: directory,
      sessionId: "session-dialogue",
      runId: "run-dialogue",
      changes: [{
        path: "after.txt",
        kind: "created" as const,
        after: {
          path: "after.txt",
          sha256: createHash("sha256").update(contents).digest("hex"),
          byteLength: contents.byteLength,
          modifiedAt: 10,
          blobPath: snapshotPath
        }
      }],
      complete: true,
      gaps: [],
      capturedAt: 20,
      dialogueEntryId: "native-leaf-before-run"
    };
    const preview = {
      id: "preview-dialogue",
      changeSetId: changeSet.id,
      conflicts: ["after.txt"],
      gaps: [],
      safe: false,
      expiresAt: Date.now() + 60_000
    };
    const navigateTree = vi.fn(async () => undefined);
    const consumeDialogueOnlyRewind = vi.fn(async () => changeSet);
    const applyRewind = vi.fn(async () => changeSet);
    const store = {
      findOperation: () => undefined,
      listSessions: () => [{
        descriptor: {
          id: "session-dialogue",
          backendId: "pi",
          targetId: "target-dialogue",
          title: "Dialogue",
          binding: { opaqueRef: "pi://dialogue", generation: 1 },
          pinned: false,
          archived: false,
          permissionMode: "ask",
          planMode: false,
          fastMode: false,
          createdAt: 1,
          updatedAt: 1
        },
        revision: 1n
      }],
      getBackend: () => ({ descriptor: { capabilities: new Map([["session.rewind", { key: "session.rewind", supported: true }]]) } }),
      getTarget: () => ({ descriptor: { id: "target-dialogue" }, metadata: { workspaceId: "workspace-dialogue" } })
    };
    const workspaceChanges = {
      getChangeSet: async () => changeSet,
      previewRewind: async () => preview,
      getRewindPreview: async () => preview,
      consumeDialogueOnlyRewind,
      applyRewind
    };
    const services = createConnectServices(stubApplication({
      store,
      workspaceChanges,
      sessionHost: immediateHost(store, { navigateTree })
    }));

    const response = await invoke<contract.PreviewWorkspaceRewindResponse>(services.workspace.previewWorkspaceRewind, {
      workspaceId: changeSet.workspaceId,
      changeSetId: changeSet.id
    });
    expect(response.preview).toMatchObject({
      previewId: preview.id,
      safety: contract.RewindSafety.BLOCKED,
      dialogueOnlyAvailable: true,
      diff: {
        files: [{ relativePath: "after.txt", status: contract.GitFileStatus.DELETED, binary: false }]
      }
    });
    expect(response.preview?.diff?.files[0]?.hunks[0]?.lines.map((line) => line.text)).toContain("after");

    const operation = await invoke<contract.SubmitOperationResponse>(services.operation.submitOperation, {
      operationId: "operation-dialogue-rewind",
      connectionId: connection.id,
      mutation: create(contract.OperationMutationSchema, {
        preconditions: [],
        payload: {
          case: "executeWorkspaceRewind",
          value: create(contract.ExecuteWorkspaceRewindMutationSchema, {
            workspaceId: changeSet.workspaceId,
            previewId: preview.id,
            changeSetId: changeSet.id,
            confirmFileRestore: false,
            allowDialogueOnly: true
          })
        }
      })
    });
    expect(navigateTree).toHaveBeenCalledWith("session-dialogue", "native-leaf-before-run", false);
    expect(consumeDialogueOnlyRewind).toHaveBeenCalledWith(preview.id);
    expect(applyRewind).not.toHaveBeenCalled();
    expect(operation.operation?.result?.payload).toMatchObject({
      case: "workspaceRewind",
      value: { dialogueRewound: true, filesRewound: false, restoredPaths: [] }
    });
  });

  it("normalizes Schedule execution snapshots including scoped extra directories", async () => {
    let captured: any;
    let targetManaged = false;
    const probeWorktree = vi.fn(async () => ({
      targetId: "target-1",
      eligibility: "eligible" as const,
      repositoryRoot: "D:\\workspace",
      currentBranch: "main",
      headCommit: "a".repeat(40),
      canRefreshRemote: true
    }));
    const listWorktreeSources = vi.fn(async () => [{
      ref: "refs/heads/main",
      commit: "a".repeat(40),
      name: "main",
      remote: false,
      current: true
    }]);
    const store = {
      findOperation: () => undefined,
      getTarget: () => ({ descriptor: {
        id: "target-1",
        backendId: "pi",
        displayName: "Project",
        workspaceRoot: "D:\\workspace",
        managed: targetManaged,
        trusted: true
      } }),
      upsertSchedule: (input: unknown) => { captured = input; return input; }
    };
    const services = createConnectServices(stubApplication({
      store,
      sessionHost: immediateHost(store),
      sessionWorktrees: { probe: probeWorktree, listSources: listWorktreeSources }
    }));
    const schedule = (extraDirectoryIds: string[]) => create(contract.ScheduleInputSchema, {
      displayName: "Nightly",
      backendId: "pi",
      targetId: "target-1",
      sessionId: "session-1",
      recurrence: create(contract.ScheduleRecurrenceSchema, {
        kind: { case: "manual", value: create(contract.ManualRecurrenceSchema, {}) }
      }),
      timeZone: "UTC",
      input: create(contract.InputContentSchema, {
        parts: [create(contract.InputPartSchema, { content: { case: "text", value: "Run the nightly task" } })]
      }),
      enabled: true,
      overlapPolicy: contract.ScheduleOverlapPolicy.QUEUE,
      misfirePolicy: contract.ScheduleMisfirePolicy.RUN_ONCE,
      execution: create(contract.ScheduleExecutionSnapshotSchema, {
        model: create(contract.ModelSelectionSchema, {
          model: create(contract.ModelKeySchema, { providerId: "provider-1", modelId: "model-1" }),
          effortId: "high",
          fastMode: true
        }),
        permissionMode: contract.PermissionMode.AUTO,
        planMode: true,
        extraDirectoryIds
      })
    });
    const mutation = (value: contract.ScheduleInput) => create(contract.OperationMutationSchema, {
      preconditions: [],
      payload: { case: "createSchedule", value: create(contract.CreateScheduleMutationSchema, { schedule: value }) }
    });

    await invoke(services.operation.submitOperation, {
      operationId: "operation-schedule",
      connectionId: connection.id,
      mutation: mutation(schedule([]))
    });
    expect(captured.executionSnapshot).toEqual({
      providerId: "provider-1",
      modelId: "model-1",
      effort: "high",
      fastMode: true,
      permissionMode: "auto",
      planMode: true,
      useWorktree: false,
      refreshWorktreeRemote: false,
      extraDirectoryIds: [],
      scheduler: {
        format: 1,
        silentWhenIdle: false,
        notify: { desktop: true },
        executionMode: "agent"
      }
    });
    expect(captured).toMatchObject({ overlapPolicy: "queue", misfirePolicy: "run_once" });
    expect(captured.sessionMode).toBe("bound");

    await invoke(services.operation.submitOperation, {
      operationId: "operation-schedule-extra-dir",
      connectionId: connection.id,
      mutation: mutation(schedule(["extra-1"]))
    });
    expect(captured.executionSnapshot.extraDirectoryIds).toEqual(["extra-1"]);

    const anchorAt = Date.now() + 60 * 60_000;
    const intervalSchedule = create(contract.ScheduleInputSchema, {
      ...schedule([]),
      displayName: "Anchored interval",
      recurrence: create(contract.ScheduleRecurrenceSchema, {
        kind: {
          case: "interval",
          value: create(contract.IntervalRecurrenceSchema, {
            interval: create(DurationSchema, { seconds: 10n }),
            anchorAt: toProtoTimestamp(anchorAt)
          })
        }
      })
    });
    await invoke(services.operation.submitOperation, {
      operationId: "operation-schedule-interval",
      connectionId: connection.id,
      mutation: mutation(intervalSchedule)
    });
    expect(captured).toMatchObject({
      kind: "interval",
      expression: "10000",
      anchorAt,
      nextRunAt: anchorAt
    });

    await expect(invoke(services.operation.submitOperation, {
      operationId: "operation-schedule-unbound",
      connectionId: connection.id,
      mutation: mutation(create(contract.ScheduleInputSchema, {
        ...intervalSchedule,
        sessionMode: contract.ScheduleSessionMode.BOUND,
        sessionId: ""
      }))
    })).rejects.toMatchObject({ code: Code.InvalidArgument });

    await invoke(services.operation.submitOperation, {
      operationId: "operation-schedule-fresh",
      connectionId: connection.id,
      mutation: mutation(create(contract.ScheduleInputSchema, {
        ...intervalSchedule,
        sessionMode: contract.ScheduleSessionMode.FRESH,
        sessionId: ""
      }))
    });
    expect(captured.sessionMode).toBe("fresh");
    expect(captured.sessionId).toBeUndefined();

    await invoke(services.operation.submitOperation, {
      operationId: "operation-schedule-worktree",
      connectionId: connection.id,
      mutation: mutation(create(contract.ScheduleInputSchema, {
        ...intervalSchedule,
        sessionMode: contract.ScheduleSessionMode.FRESH,
        sessionId: "",
        execution: create(contract.ScheduleExecutionSnapshotSchema, {
          executionMode: contract.ScheduleExecutionMode.AGENT,
          permissionMode: contract.PermissionMode.ASK,
          useWorktree: true,
          worktreeSourceRef: "refs/heads/main",
          refreshWorktreeRemote: true
        })
      }))
    });
    expect(captured).toMatchObject({
      sessionMode: "fresh",
      executionSnapshot: {
        useWorktree: true,
        worktreeSourceRef: "refs/heads/main",
        refreshWorktreeRemote: true
      }
    });
    expect(probeWorktree).toHaveBeenCalledOnce();
    expect(listWorktreeSources).toHaveBeenCalledOnce();

    await expect(invoke(services.operation.submitOperation, {
      operationId: "operation-schedule-worktree-persistent",
      connectionId: connection.id,
      mutation: mutation(create(contract.ScheduleInputSchema, {
        ...intervalSchedule,
        sessionMode: contract.ScheduleSessionMode.PERSISTENT,
        sessionId: "",
        execution: create(contract.ScheduleExecutionSnapshotSchema, {
          executionMode: contract.ScheduleExecutionMode.AGENT,
          permissionMode: contract.PermissionMode.ASK,
          useWorktree: true
        })
      }))
    })).rejects.toMatchObject({ code: Code.InvalidArgument });

    targetManaged = true;
    await expect(invoke(services.operation.submitOperation, {
      operationId: "operation-schedule-worktree-managed",
      connectionId: connection.id,
      mutation: mutation(create(contract.ScheduleInputSchema, {
        ...intervalSchedule,
        sessionMode: contract.ScheduleSessionMode.FRESH,
        sessionId: "",
        execution: create(contract.ScheduleExecutionSnapshotSchema, {
          executionMode: contract.ScheduleExecutionMode.AGENT,
          permissionMode: contract.PermissionMode.ASK,
          useWorktree: true
        })
      }))
    })).rejects.toMatchObject({ code: Code.InvalidArgument });
    targetManaged = false;

    listWorktreeSources.mockRejectedValueOnce(new Error("source probe unavailable"));
    await expect(invoke(services.operation.submitOperation, {
      operationId: "operation-schedule-worktree-source-fail",
      connectionId: connection.id,
      mutation: mutation(create(contract.ScheduleInputSchema, {
        ...intervalSchedule,
        sessionMode: contract.ScheduleSessionMode.FRESH,
        sessionId: "",
        execution: create(contract.ScheduleExecutionSnapshotSchema, {
          executionMode: contract.ScheduleExecutionMode.AGENT,
          permissionMode: contract.PermissionMode.ASK,
          useWorktree: true,
          worktreeSourceRef: "refs/heads/main"
        })
      }))
    })).rejects.toMatchObject({ code: Code.InvalidArgument });

    probeWorktree.mockRejectedValueOnce(new Error("probe unavailable"));
    await invoke(services.operation.submitOperation, {
      operationId: "operation-schedule-worktree-disabled-probe",
      connectionId: connection.id,
      mutation: mutation(create(contract.ScheduleInputSchema, {
        ...intervalSchedule,
        enabled: false,
        sessionMode: contract.ScheduleSessionMode.FRESH,
        sessionId: "",
        execution: create(contract.ScheduleExecutionSnapshotSchema, {
          executionMode: contract.ScheduleExecutionMode.AGENT,
          permissionMode: contract.PermissionMode.ASK,
          useWorktree: true
        })
      }))
    });
    expect(captured).toMatchObject({ enabled: false, executionSnapshot: { useWorktree: true } });

    const expiresAt = anchorAt + 24 * 60 * 60_000;
    await invoke(services.operation.submitOperation, {
      operationId: "operation-schedule-script",
      connectionId: connection.id,
      mutation: mutation(create(contract.ScheduleInputSchema, {
        ...schedule([]),
        sessionMode: contract.ScheduleSessionMode.FRESH,
        sessionId: "",
        input: create(contract.InputContentSchema, {}),
        execution: create(contract.ScheduleExecutionSnapshotSchema, {
          executionMode: contract.ScheduleExecutionMode.SCRIPT,
          script: create(contract.ScheduleScriptExecutionSchema, {
            command: "node task.mjs",
            timeout: create(DurationSchema, { seconds: 45n }),
            capabilities: [contract.ScheduleScriptCapability.SESSIONS_DISPATCH]
          }),
          notify: create(contract.ScheduleNotificationSchema, { desktop: false }),
          expireAt: toProtoTimestamp(expiresAt),
          permissionMode: contract.PermissionMode.ASK
        })
      }))
    });
    expect(captured).toMatchObject({
      sessionMode: "fresh",
      prompt: { text: "" },
      executionSnapshot: {
        scheduler: {
          format: 1,
          executionMode: "script",
          scriptConfig: {
            command: "node task.mjs",
            timeoutMs: 45_000,
            capabilities: ["sessions.dispatch"]
          },
          silentWhenIdle: false,
          notify: { desktop: false },
          expireAt: expiresAt
        }
      }
    });

    await expect(invoke(services.operation.submitOperation, {
      operationId: "operation-schedule-script-secret",
      connectionId: connection.id,
      mutation: mutation(create(contract.ScheduleInputSchema, {
        ...schedule([]),
        sessionMode: contract.ScheduleSessionMode.FRESH,
        sessionId: "",
        input: create(contract.InputContentSchema, {}),
        execution: create(contract.ScheduleExecutionSnapshotSchema, {
          executionMode: contract.ScheduleExecutionMode.SCRIPT,
          script: create(contract.ScheduleScriptExecutionSchema, {
            command: "curl -H 'Authorization: Bearer super-secret-schedule-token' https://example.test",
            capabilities: []
          })
        })
      }))
    })).rejects.toMatchObject({ code: Code.InvalidArgument });

    await expect(invoke(services.operation.submitOperation, {
      operationId: "operation-schedule-forged-hook",
      connectionId: connection.id,
      mutation: mutation(create(contract.ScheduleInputSchema, {
        ...schedule([]),
        execution: create(contract.ScheduleExecutionSnapshotSchema, {
          executionMode: contract.ScheduleExecutionMode.AGENT,
          preRunHook: create(contract.SchedulePreRunHookSchema, {
            command: "node hook.mjs",
            filePath: "D:\\workspace\\hook.mjs"
          })
        })
      }))
    })).rejects.toMatchObject({ code: Code.InvalidArgument });
  });

  it("commits Pi settings before refreshing, hot-applies active runtimes, and never activates idle sessions", async () => {
    const order: string[] = [];
    let storedSetting: contract.PiSettingsPatch | undefined;
    let nextGenerationSetting: contract.PiSettingsPatch | undefined;
    const store = {
      findOperation: () => undefined,
      findSetting: () => storedSetting === undefined ? undefined : { value: storedSetting },
      listSessions: () => { throw new Error("Settings update must not enumerate and activate durable sessions."); },
      setSetting: (_scope: string, _owner: string, key: string, value: unknown) => {
        expect(key).toBe("settings.pi.pi");
        storedSetting = value as contract.PiSettingsPatch;
        order.push("commit");
      },
      appendDiagnostic: vi.fn()
    };
    const runtime = Object.assign(Object.create(PiBackendAdapter.prototype) as PiBackendAdapter, {
      setAutoCompaction: vi.fn(async (enabled: boolean) => { order.push(`compact:session-active:${enabled}`); }),
      setAutoCompactionThreshold: vi.fn(async (percent: number) => { order.push(`threshold:session-active:${percent}`); }),
      setAutoRetry: vi.fn(async (enabled: boolean) => { order.push(`retry:session-active:${enabled}`); })
    });
    Object.defineProperty(runtime, "id", { value: "pi" });
    const applyToActiveSessions = vi.fn(async (
      filter: { readonly backendId: string },
      effect: (sessionId: string, adapter: typeof runtime, context: object) => Promise<void>
    ) => {
      expect(filter).toEqual({ backendId: "pi" });
      order.push("active-only");
      await effect("session-active", runtime, {});
      return ["session-active"];
    });
    const services = createConnectServices(stubApplication({
      store,
      sessionHost: immediateHost(store, { applyToActiveSessions }),
      adapters: [runtime],
      refreshPiGeneration: async () => {
        nextGenerationSetting = storedSetting;
        order.push("refresh");
      }
    }));

    await expect(invoke(services.operation.submitOperation, {
      operationId: "operation-pi-settings-invalid-threshold",
      connectionId: connection.id,
      mutation: create(contract.OperationMutationSchema, {
        preconditions: [],
        payload: {
          case: "updatePiSettings",
          value: create(contract.UpdatePiSettingsMutationSchema, {
            patch: create(contract.PiSettingsPatchSchema, {
              backendId: "pi",
              autoCompactionThresholdPercent: 49
            })
          })
        }
      })
    })).rejects.toMatchObject({ code: Code.InvalidArgument });
    expect(storedSetting).toBeUndefined();

    await invoke(services.operation.submitOperation, {
      operationId: "operation-pi-settings-order",
      connectionId: connection.id,
      mutation: create(contract.OperationMutationSchema, {
        preconditions: [],
        payload: {
          case: "updatePiSettings",
          value: create(contract.UpdatePiSettingsMutationSchema, {
            patch: create(contract.PiSettingsPatchSchema, {
              backendId: "pi",
              autoCompaction: false,
              autoCompactionThresholdPercent: 70,
              autoRetry: false
            })
          })
        }
      })
    });

    expect(order).toEqual([
      "commit",
      "refresh",
      "active-only",
      "compact:session-active:false",
      "threshold:session-active:70",
      "retry:session-active:false"
    ]);
    expect(applyToActiveSessions).toHaveBeenCalledOnce();
    expect(runtime.setAutoCompaction).toHaveBeenCalledOnce();
    expect(runtime.setAutoCompactionThreshold).toHaveBeenCalledOnce();
    expect(runtime.setAutoRetry).toHaveBeenCalledOnce();
    expect(nextGenerationSetting).toMatchObject({ autoCompaction: false, autoCompactionThresholdPercent: 70, autoRetry: false });

    order.length = 0;
    await invoke(services.operation.submitOperation, {
      operationId: "operation-pi-settings-reset-threshold",
      connectionId: connection.id,
      mutation: create(contract.OperationMutationSchema, {
        preconditions: [],
        payload: {
          case: "updatePiSettings",
          value: create(contract.UpdatePiSettingsMutationSchema, {
            patch: create(contract.PiSettingsPatchSchema, {
              backendId: "pi",
              resetAutoCompactionThresholdPercent: true
            })
          })
        }
      })
    });
    expect(storedSetting?.autoCompactionThresholdPercent).toBeUndefined();
    expect(storedSetting).toMatchObject({ autoCompaction: false, autoRetry: false });
    expect(order).toEqual([
      "commit",
      "refresh",
      "active-only",
      "threshold:session-active:75"
    ]);
    expect(runtime.setAutoCompactionThreshold).toHaveBeenLastCalledWith(75, {});
  });

  it("rejects a namespaced Pi settings mutation for a different Adapter family", async () => {
    const setSetting = vi.fn();
    const store = { findOperation: () => undefined, setSetting };
    const services = createConnectServices(stubApplication({
      store,
      adapters: [{ id: "generic-backend" } as unknown as BackendAdapter],
      sessionHost: immediateHost(store)
    }));

    const response = await invoke<contract.SubmitOperationResponse>(services.operation.submitOperation, {
      operationId: "operation-pi-settings-wrong-namespace",
      connectionId: connection.id,
      mutation: create(contract.OperationMutationSchema, {
        payload: {
          case: "updatePiSettings",
          value: create(contract.UpdatePiSettingsMutationSchema, {
            patch: create(contract.PiSettingsPatchSchema, {
              backendId: "generic-backend",
              autoRetry: true
            })
          })
        }
      })
    });

    expect(response.operation).toMatchObject({ state: contract.OperationState.FAILED });
    expect(setSetting).not.toHaveBeenCalled();
  });

  it("admits Backend defaults only from the current capability manifest", async () => {
    const capabilities = new Map<string, { key: string; supported: boolean; options?: readonly string[] }>();
    const setSetting = vi.fn();
    const deleteSetting = vi.fn();
    const store = {
      findOperation: () => undefined,
      findSetting: () => undefined,
      setSetting,
      deleteSetting,
      getBackend: () => ({
        descriptor: {
          id: "backend-settings",
          capabilities,
          models: [{ providerId: "provider", modelId: "model" }]
        }
      })
    };
    const services = createConnectServices(stubApplication({
      store,
      sessionHost: immediateHost(store)
    }));
    const submit = (operationId: string, patch: contract.BackendSettingsPatch) => invoke<contract.SubmitOperationResponse>(
      services.operation.submitOperation,
      {
        operationId,
        connectionId: connection.id,
        mutation: create(contract.OperationMutationSchema, {
          payload: {
            case: "updateBackendSettings",
            value: create(contract.UpdateBackendSettingsMutationSchema, { patch })
          }
        })
      }
    );

    const unsupportedModel = await submit(
      "operation-backend-settings-model-unsupported",
      create(contract.BackendSettingsPatchSchema, {
        backendId: "backend-settings",
        defaultModel: create(contract.ModelSelectionSchema, {
          model: create(contract.ModelKeySchema, { providerId: "provider", modelId: "model" })
        })
      })
    );
    expect(unsupportedModel.operation).toMatchObject({ state: contract.OperationState.FAILED });

    const unsupportedPermission = await submit(
      "operation-backend-settings-permission-unsupported",
      create(contract.BackendSettingsPatchSchema, {
        backendId: "backend-settings",
        defaultPermissionMode: contract.PermissionMode.AUTO
      })
    );
    expect(unsupportedPermission.operation).toMatchObject({ state: contract.OperationState.FAILED });

    capabilities.set("permission.modes", {
      key: "permission.modes",
      supported: true,
      options: ["ask"]
    });
    const unadvertisedPermission = await submit(
      "operation-backend-settings-permission-unadvertised",
      create(contract.BackendSettingsPatchSchema, {
        backendId: "backend-settings",
        defaultPermissionMode: contract.PermissionMode.AUTO
      })
    );
    expect(unadvertisedPermission.operation).toMatchObject({ state: contract.OperationState.FAILED });
    expect(setSetting).not.toHaveBeenCalled();

    const admittedPermission = await submit(
      "operation-backend-settings-permission-admitted",
      create(contract.BackendSettingsPatchSchema, {
        backendId: "backend-settings",
        defaultPermissionMode: contract.PermissionMode.ASK
      })
    );
    expect(admittedPermission.operation).toMatchObject({ state: contract.OperationState.SUCCEEDED });
    expect(setSetting).toHaveBeenCalledOnce();

    const unsupportedPlan = await submit(
      "operation-backend-settings-plan-unsupported",
      create(contract.BackendSettingsPatchSchema, {
        backendId: "backend-settings",
        defaultPlanMode: true
      })
    );
    expect(unsupportedPlan.operation).toMatchObject({ state: contract.OperationState.FAILED });
    expect(setSetting).toHaveBeenCalledOnce();

    const clearedUnsupportedPlan = await submit(
      "operation-backend-settings-plan-clear",
      create(contract.BackendSettingsPatchSchema, {
        backendId: "backend-settings",
        defaultPlanMode: false
      })
    );
    expect(clearedUnsupportedPlan.operation).toMatchObject({ state: contract.OperationState.SUCCEEDED });
    expect(setSetting).toHaveBeenCalledTimes(2);

    const disabledModel = await submit(
      "operation-backend-settings-disable-model",
      create(contract.BackendSettingsPatchSchema, {
        backendId: "backend-settings",
        modelAccessUpdate: create(contract.BackendModelAccessUpdateSchema, {
          providerId: "provider",
          modelId: "model",
          enabled: false
        })
      })
    );
    expect(disabledModel.operation).toMatchObject({ state: contract.OperationState.SUCCEEDED });
    expect(setSetting).toHaveBeenLastCalledWith(
      "service",
      "orchestrator",
      "settings.model_access.backend-settings",
      expect.objectContaining({ disabledModels: [expect.objectContaining({ providerId: "provider", modelId: "model" })] })
    );
  });

  it("keeps disabled managed catalog models visible and eligible for re-enabling", async () => {
    const backend = {
      id: "backend-managed-catalog",
      authenticationState: "authenticated" as const,
      capabilities: new Map([["provider.managed_catalog", { key: "provider.managed_catalog", supported: true }]]),
      models: []
    };
    const record = { descriptor: backend, revision: 1n };
    const deleteSetting = vi.fn();
    const store = {
      findOperation: () => undefined,
      listBackends: () => [record],
      getBackend: () => record,
      findSetting: () => ({
        value: create(contract.BackendModelAccessSettingsSchema, {
          disabledModels: [create(contract.ModelKeySchema, { providerId: "managed", modelId: "catalog-model" })]
        })
      }),
      setSetting: vi.fn(),
      deleteSetting
    };
    const providers = {
      list: () => [{
        provider: {
          id: "managed",
          api: "openai-responses",
          models: [{ id: "catalog-model", name: "Catalog model" }]
        },
        displayName: "Managed",
        authenticationState: "authenticated"
      }]
    };
    const refreshPiGeneration = vi.fn(async () => undefined);
    const services = createConnectServices(stubApplication({
      store,
      providers,
      providerAuth: {
        listNativeModels: () => [{
          providerId: "native",
          modelId: "native-model",
          displayName: "Native model",
          api: "openai-responses",
          contextWindow: 128_000,
          maxOutputTokens: 8_192,
          supportsImages: true,
          thinkingLevels: [],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
        }]
      },
      refreshPiGeneration,
      sessionHost: immediateHost(store)
    }));

    const listed = await invoke<contract.ListModelsResponse>(services.backend.listModels, {
      backendId: backend.id,
      providerId: "",
      page: create(contract.PageRequestSchema)
    });
    expect(listed.models).toHaveLength(2);
    expect(listed.models).toEqual(expect.arrayContaining([
      expect.objectContaining({
        backendId: backend.id,
        key: expect.objectContaining({ providerId: "managed", modelId: "catalog-model" })
      }),
      expect.objectContaining({
        backendId: backend.id,
        key: expect.objectContaining({ providerId: "native", modelId: "native-model" })
      })
    ]));

    const response = await invoke<contract.SubmitOperationResponse>(services.operation.submitOperation, {
      operationId: "operation-enable-managed-catalog-model",
      connectionId: connection.id,
      mutation: create(contract.OperationMutationSchema, {
        payload: {
          case: "updateBackendSettings",
          value: create(contract.UpdateBackendSettingsMutationSchema, {
            patch: create(contract.BackendSettingsPatchSchema, {
              backendId: backend.id,
              modelAccessUpdate: create(contract.BackendModelAccessUpdateSchema, {
                providerId: "managed",
                modelId: "catalog-model",
                enabled: true
              })
            })
          })
        }
      })
    });

    expect(response.operation).toMatchObject({ state: contract.OperationState.SUCCEEDED });
    expect(deleteSetting).toHaveBeenCalledWith(
      "service",
      "orchestrator",
      "settings.model_access.backend-managed-catalog"
    );
    expect(refreshPiGeneration).toHaveBeenCalledOnce();
  });

  it("clears a stored disabled model after it disappears from the current catalog", async () => {
    const backend = {
      id: "backend-stale-model",
      authenticationState: "authenticated" as const,
      capabilities: new Map([["provider.managed_catalog", { key: "provider.managed_catalog", supported: true }]]),
      models: []
    };
    const record = { descriptor: backend, revision: 1n };
    const deleteSetting = vi.fn();
    const store = {
      findOperation: () => undefined,
      listBackends: () => [record],
      getBackend: () => record,
      findSetting: () => ({
        value: create(contract.BackendModelAccessSettingsSchema, {
          disabledModels: [create(contract.ModelKeySchema, { providerId: "removed", modelId: "removed-model" })]
        })
      }),
      setSetting: vi.fn(),
      deleteSetting
    };
    const refreshPiGeneration = vi.fn(async () => undefined);
    const services = createConnectServices(stubApplication({
      store,
      providers: { list: () => [] },
      providerAuth: { listNativeModels: () => [] },
      refreshPiGeneration,
      sessionHost: immediateHost(store)
    }));

    const response = await invoke<contract.SubmitOperationResponse>(services.operation.submitOperation, {
      operationId: "operation-clear-stale-disabled-model",
      connectionId: connection.id,
      mutation: create(contract.OperationMutationSchema, {
        payload: {
          case: "updateBackendSettings",
          value: create(contract.UpdateBackendSettingsMutationSchema, {
            patch: create(contract.BackendSettingsPatchSchema, {
              backendId: backend.id,
              modelAccessUpdate: create(contract.BackendModelAccessUpdateSchema, {
                providerId: "removed",
                modelId: "removed-model",
                enabled: true
              })
            })
          })
        }
      })
    });

    expect(response.operation).toMatchObject({ state: contract.OperationState.SUCCEEDED });
    expect(deleteSetting).toHaveBeenCalledWith(
      "service",
      "orchestrator",
      "settings.model_access.backend-stale-model"
    );
    expect(refreshPiGeneration).toHaveBeenCalledOnce();
  });

  it("reconciles a committed model access update again when its first generation refresh failed", async () => {
    const backend = {
      id: "backend-refresh-replay",
      authenticationState: "authenticated" as const,
      capabilities: new Map([["provider.managed_catalog", { key: "provider.managed_catalog", supported: true }]]),
      models: [{
        providerId: "managed",
        modelId: "model",
        displayName: "Model",
        api: "openai-responses" as const,
        contextWindow: 128_000,
        maxOutputTokens: 8_192,
        supportsImages: true,
        thinkingLevels: [],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
      }]
    };
    const record = { descriptor: backend, revision: 1n };
    let storedAccess: contract.BackendModelAccessSettings | undefined;
    const store = {
      findOperation: () => undefined,
      listBackends: () => [record],
      getBackend: () => record,
      findSetting: () => storedAccess === undefined ? undefined : { value: storedAccess },
      setSetting: (_scope: string, _owner: string, _key: string, value: contract.BackendModelAccessSettings) => {
        storedAccess = value;
      },
      deleteSetting: () => { storedAccess = undefined; }
    };
    type ReplayStore = typeof store;
    let completed: {
      readonly value: unknown;
      readonly operation: OperationRecord<unknown>;
    } | undefined;
    const sessionHost = {
      mutate: async (input: {
        operationId: string;
        kind: string;
        body: unknown;
        commit: (store: ReplayStore) => unknown;
      }) => {
        if (completed !== undefined) return { replayed: true, ...completed };
        const value = input.commit(store);
        completed = { value, operation: completedRecord(input.operationId, input.kind, input.body, value) };
        return { replayed: false, ...completed };
      }
    };
    const refreshPiGeneration = vi.fn()
      .mockRejectedValueOnce(new Error("generation refresh failed"))
      .mockResolvedValueOnce(undefined);
    const services = createConnectServices(stubApplication({
      store,
      providers: { list: () => [] },
      providerAuth: { listNativeModels: () => [] },
      refreshPiGeneration,
      sessionHost
    }));
    const request = {
      operationId: "operation-reconcile-model-access",
      connectionId: connection.id,
      mutation: create(contract.OperationMutationSchema, {
        payload: {
          case: "updateBackendSettings",
          value: create(contract.UpdateBackendSettingsMutationSchema, {
            patch: create(contract.BackendSettingsPatchSchema, {
              backendId: backend.id,
              modelAccessUpdate: create(contract.BackendModelAccessUpdateSchema, {
                providerId: "managed",
                modelId: "model",
                enabled: false
              })
            })
          })
        }
      })
    };

    await expect(invoke(services.operation.submitOperation, request)).rejects.toThrow("generation refresh failed");
    await expect(invoke<contract.SubmitOperationResponse>(services.operation.submitOperation, request))
      .resolves.toMatchObject({ operation: { state: contract.OperationState.SUCCEEDED } });
    expect(refreshPiGeneration).toHaveBeenCalledTimes(2);
  });

  it("routes RestartBackend through the Backend instance replacement effect", async () => {
    const restartBackend = vi.fn(async () => undefined);
    const restartSession = vi.fn(async () => undefined);
    const store = { findOperation: () => undefined };
    const services = createConnectServices(stubApplication({
      store,
      restartBackend,
      sessionHost: immediateHost(store, { restart: restartSession })
    }));

    const response = await invoke<contract.SubmitOperationResponse>(services.operation.submitOperation, {
      operationId: "operation-restart-backend-instance",
      connectionId: connection.id,
      mutation: create(contract.OperationMutationSchema, {
        payload: {
          case: "restartBackend",
          value: create(contract.RestartBackendMutationSchema, { backendId: "backend-settings" })
        }
      })
    });

    expect(response.operation).toMatchObject({ state: contract.OperationState.SUCCEEDED });
    expect(restartBackend).toHaveBeenCalledExactlyOnceWith("backend-settings");
    expect(restartSession).not.toHaveBeenCalled();
  });

  it("validates, persists, hot-applies, resets, and cleans every runtime governance setting", async () => {
    const updateAgentResource = vi.fn();
    const resetAgentResource = vi.fn();
    const updateCollaboration = vi.fn();
    const resetCollaboration = vi.fn();
    const updateGitSafety = vi.fn();
    const resetGitSafety = vi.fn();
    const cleanupAll = vi.fn(async () => ({ removedSessions: 2, repositoriesVisited: 1 }));
    const applyProcessPriorityToActive = vi.fn(async () => []);
    const runtime = { id: "generic-runtime", applyProcessPriorityToActive } as unknown as BackendAdapter;
    const runtimeWithoutPriorityHook = { id: "runtime-without-priority-hook" } as unknown as BackendAdapter;
    const currentAdapters = new Map([
      [runtime.id, runtime],
      [runtimeWithoutPriorityHook.id, runtimeWithoutPriorityHook]
    ]);
    const invokeBackendAdapter = vi.fn(async (
      backendId: string,
      effect: (adapter: BackendAdapter, backendInstanceGeneration: number) => Promise<unknown>
    ) => effect(currentAdapters.get(backendId)!, 7));
    const store = { findOperation: () => undefined };
    const services = createConnectServices(stubApplication({
      store,
      sessionHost: immediateHost(store, { invokeBackendAdapter }),
      adapters: [runtimeWithoutPriorityHook, runtime],
      runtimeGovernance: {
        updateAgentResource,
        resetAgentResource,
        updateCollaboration,
        resetCollaboration,
        updateGitSafety,
        resetGitSafety,
        collaboration: () => ({ workerSoftLimit: 5, workerHardLimit: 8, workerIdleReleaseMinutes: 0 })
      },
      gitSafety: { cleanupAll }
    }));
    const submit = (operationId: string, payload: contract.OperationMutation["payload"]) => invoke(
      services.operation.submitOperation,
      {
        operationId,
        connectionId: connection.id,
        mutation: create(contract.OperationMutationSchema, { payload })
      }
    );

    await submit("operation-agent-resource", {
      case: "updateAgentResourceSettings",
      value: create(contract.UpdateAgentResourceSettingsMutationSchema, {
        patch: create(contract.AgentResourceSettingsPatchSchema, {
          maxConcurrentCommands: 4,
          processPriority: contract.ManagedProcessPriority.LOW,
          capToolchainThreads: true
        })
      })
    });
    expect(updateAgentResource).toHaveBeenCalledWith({
      maxConcurrentCommands: 4,
      processPriority: "low",
      capToolchainThreads: true
    });
    expect(applyProcessPriorityToActive).toHaveBeenCalledWith("low");
    expect(invokeBackendAdapter).toHaveBeenCalledTimes(2);

    await submit("operation-agent-resource-reset", {
      case: "updateAgentResourceSettings",
      value: create(contract.UpdateAgentResourceSettingsMutationSchema, {
        patch: create(contract.AgentResourceSettingsPatchSchema, { resetAll: true })
      })
    });
    expect(resetAgentResource).toHaveBeenCalledOnce();
    expect(applyProcessPriorityToActive).toHaveBeenLastCalledWith("normal");
    expect(invokeBackendAdapter).toHaveBeenCalledTimes(4);

    await expect(submit("operation-collaboration-invalid", {
      case: "updateCollaborationSettings",
      value: create(contract.UpdateCollaborationSettingsMutationSchema, {
        patch: create(contract.CollaborationSettingsPatchSchema, {
          workerSoftLimit: 9,
          workerHardLimit: 3
        })
      })
    })).rejects.toMatchObject({ code: Code.InvalidArgument });
    expect(updateCollaboration).not.toHaveBeenCalled();

    await submit("operation-collaboration", {
      case: "updateCollaborationSettings",
      value: create(contract.UpdateCollaborationSettingsMutationSchema, {
        patch: create(contract.CollaborationSettingsPatchSchema, {
          workerSoftLimit: 4,
          workerHardLimit: 9,
          workerIdleReleaseMinutes: 10
        })
      })
    });
    expect(updateCollaboration).toHaveBeenCalledWith({
      workerSoftLimit: 4,
      workerHardLimit: 9,
      workerIdleReleaseMinutes: 10
    });

    await submit("operation-git-safety", {
      case: "updateGitSafetySettings",
      value: create(contract.UpdateGitSafetySettingsMutationSchema, {
        patch: create(contract.GitSafetySettingsPatchSchema, { autoSnapshotEnabled: true })
      })
    });
    expect(updateGitSafety).toHaveBeenCalledWith({ autoSnapshotEnabled: true });
    await submit("operation-git-safety-reset", {
      case: "updateGitSafetySettings",
      value: create(contract.UpdateGitSafetySettingsMutationSchema, {
        patch: create(contract.GitSafetySettingsPatchSchema, { resetAll: true })
      })
    });
    expect(resetGitSafety).toHaveBeenCalledOnce();
    await submit("operation-git-safety-cleanup", {
      case: "cleanupGitSafetySavepoints",
      value: create(contract.CleanupGitSafetySavepointsMutationSchema, {})
    });
    expect(cleanupAll).toHaveBeenCalledOnce();
    expect(resetAgentResource).toHaveBeenCalledOnce();
    expect(resetCollaboration).not.toHaveBeenCalled();
  });

  it("persists the default-off language tool opt-in without mutating any existing runtime", async () => {
    let stored: unknown;
    const refreshPiGeneration = vi.fn(async () => undefined);
    const applyToActiveSessions = vi.fn(async () => []);
    const store = {
      findOperation: () => undefined,
      setSetting: (_scope: string, _owner: string, key: string, value: unknown) => {
        expect(key).toBe("settings.language_tools");
        stored = value;
      }
    };
    const services = createConnectServices(stubApplication({
      store,
      sessionHost: immediateHost(store, { applyToActiveSessions }),
      refreshPiGeneration
    }));

    await expect(invoke(services.operation.submitOperation, {
      operationId: "operation-language-tools-missing",
      connectionId: connection.id,
      mutation: create(contract.OperationMutationSchema, {
        payload: {
          case: "updateLanguageToolSettings",
          value: create(contract.UpdateLanguageToolSettingsMutationSchema, {})
        }
      })
    })).rejects.toMatchObject({ code: Code.InvalidArgument });
    expect(stored).toBeUndefined();

    await invoke(services.operation.submitOperation, {
      operationId: "operation-language-tools-enable",
      connectionId: connection.id,
      mutation: create(contract.OperationMutationSchema, {
        payload: {
          case: "updateLanguageToolSettings",
          value: create(contract.UpdateLanguageToolSettingsMutationSchema, {
            patch: create(contract.LanguageToolSettingsPatchSchema, { enabled: true })
          })
        }
      })
    });

    expect(stored).toMatchObject({ enabled: true });
    expect(refreshPiGeneration).not.toHaveBeenCalled();
    expect(applyToActiveSessions).not.toHaveBeenCalled();
  });

  it("persists, resets, and hot-applies silent encrypted retry through its advertised capability", async () => {
    const order: string[] = [];
    let stored: { readonly enabled: boolean } | undefined;
    const store = {
      findOperation: () => undefined,
      listBackends: () => [{ descriptor: {
        id: "responses-backend",
        capabilities: new Map([["context.silent_encrypted_retry", {
          key: "context.silent_encrypted_retry",
          supported: true
        }]])
      } }],
      setSetting: (_scope: string, _owner: string, key: string, value: unknown) => {
        expect(key).toBe("settings.personalization.silent_encrypted_retry");
        stored = value as { readonly enabled: boolean };
        order.push(`set:${stored.enabled}`);
      },
      deleteSetting: (_scope: string, _owner: string, key: string) => {
        expect(key).toBe("settings.personalization.silent_encrypted_retry");
        stored = undefined;
        order.push("reset");
      },
      appendDiagnostic: vi.fn()
    };
    const adapter = {
      id: "responses-backend",
      configureSilentEncryptedRetry: vi.fn(async (enabled: boolean) => {
        order.push(`future:${enabled}`);
      }),
      setSilentEncryptedRetry: vi.fn(async (enabled: boolean) => {
        order.push(`runtime:${enabled}`);
      })
    };
    const applyToActiveSessions = vi.fn(async (
      filter: { readonly backendId: string },
      effect: (sessionId: string, runtime: typeof adapter, context: object) => Promise<void>
    ) => {
      expect(filter).toEqual({ backendId: "responses-backend" });
      await effect("active-session", adapter, {});
      return ["active-session"];
    });
    const invokeBackendAdapter = vi.fn(async (
      backendId: string,
      effect: (runtime: typeof adapter, backendInstanceGeneration: number) => Promise<unknown>
    ) => {
      expect(backendId).toBe("responses-backend");
      return effect(adapter, 11);
    });
    const services = createConnectServices(stubApplication({
      store,
      sessionHost: immediateHost(store, { applyToActiveSessions, invokeBackendAdapter }),
      adapters: [adapter]
    }));
    const submit = (operationId: string, patch: contract.PersonalizationSettingsPatch) => invoke(
      services.operation.submitOperation,
      {
        operationId,
        connectionId: connection.id,
        mutation: create(contract.OperationMutationSchema, {
          preconditions: [],
          payload: {
            case: "updatePersonalizationSettings",
            value: create(contract.UpdatePersonalizationSettingsMutationSchema, { patch })
          }
        })
      }
    );

    await submit("operation-encrypted-retry-off", create(contract.PersonalizationSettingsPatchSchema, {
      silentEncryptedRetryEnabled: false
    }));
    expect(order).toEqual(["set:false", "future:false", "runtime:false"]);
    expect(stored).toEqual({ enabled: false });
    expect(invokeBackendAdapter).toHaveBeenCalledTimes(1);

    order.length = 0;
    await submit("operation-encrypted-retry-reset", create(contract.PersonalizationSettingsPatchSchema, {
      resetSilentEncryptedRetry: true
    }));
    expect(order).toEqual(["reset", "future:true", "runtime:true"]);
    expect(stored).toBeUndefined();
    expect(invokeBackendAdapter).toHaveBeenCalledTimes(2);

    await expect(submit("operation-encrypted-retry-invalid", create(contract.PersonalizationSettingsPatchSchema, {
      silentEncryptedRetryEnabled: false,
      resetSilentEncryptedRetry: true
    }))).rejects.toMatchObject({ code: Code.InvalidArgument });
    expect(store.appendDiagnostic).not.toHaveBeenCalled();
  });

  it("persists and removes the default-off task model fallback override", async () => {
    let stored: { readonly enabled: boolean } | undefined;
    const store = {
      findOperation: () => undefined,
      setSetting: (_scope: string, _owner: string, key: string, value: unknown) => {
        expect(key).toBe("settings.personalization.session_runtime_fallback");
        stored = value as { readonly enabled: boolean };
      },
      deleteSetting: (_scope: string, _owner: string, key: string) => {
        expect(key).toBe("settings.personalization.session_runtime_fallback");
        stored = undefined;
      }
    };
    const services = createConnectServices(stubApplication({
      store,
      sessionHost: immediateHost(store)
    }));
    const submit = (operationId: string, patch: contract.PersonalizationSettingsPatch) => invoke(
      services.operation.submitOperation,
      {
        operationId,
        connectionId: connection.id,
        mutation: create(contract.OperationMutationSchema, {
          preconditions: [],
          payload: {
            case: "updatePersonalizationSettings",
            value: create(contract.UpdatePersonalizationSettingsMutationSchema, { patch })
          }
        })
      }
    );

    await submit("operation-runtime-fallback-on", create(contract.PersonalizationSettingsPatchSchema, {
      sessionRuntimeFallbackEnabled: true
    }));
    expect(stored).toEqual({ enabled: true });

    await submit("operation-runtime-fallback-reset", create(contract.PersonalizationSettingsPatchSchema, {
      resetSessionRuntimeFallback: true
    }));
    expect(stored).toBeUndefined();

    await expect(submit("operation-runtime-fallback-invalid", create(contract.PersonalizationSettingsPatchSchema, {
      sessionRuntimeFallbackEnabled: true,
      resetSessionRuntimeFallback: true
    }))).rejects.toMatchObject({ code: Code.InvalidArgument });
  });
});

function linearSessionTree(count: number): SessionTreeNode {
  let current: SessionTreeNode | undefined;
  for (let index = count - 1; index >= 0; index -= 1) {
    current = {
      entryId: `tree-entry-${index}`,
      ...(index === 0 ? {} : { parentId: `tree-entry-${index - 1}` }),
      kind: "message",
      role: index % 2 === 0 ? "user" : "assistant",
      label: `entry ${index}`,
      timestamp: index,
      children: current === undefined ? [] : [current]
    };
  }
  if (current === undefined) throw new Error("Tree node count must be positive.");
  return current;
}

function linearTreeDepth(root: { readonly children: readonly unknown[] } | undefined): number {
  let current: unknown = root;
  let depth = 0;
  while (current !== undefined) {
    if (typeof current !== "object" || current === null) throw new Error("Tree node is invalid.");
    const children = (current as { readonly children?: unknown }).children;
    if (!Array.isArray(children) || children.length > 1) throw new Error("Tree is not linear.");
    depth += 1;
    current = children[0];
  }
  return depth;
}
