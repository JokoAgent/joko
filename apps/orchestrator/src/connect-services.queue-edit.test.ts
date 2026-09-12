import { create } from "@bufbuild/protobuf";
import * as contract from "@joko/contracts";
import { operationBodyHash, type OperationRecord, type QueueItemRecord } from "@joko/store";
import { expect, it, vi } from "vitest";

import type { OrchestratorApplication } from "./application.js";
import { createConnectServices } from "./connect-services.js";

const connection = {
  id: "queue-edit-connection",
  name: "Queue edit test",
  authKeyDigest: "digest",
  state: "active" as const,
  pairedAt: 1,
  revision: 1n
};

function context(): unknown {
  return {
    requestHeader: new Headers({ authorization: "Bearer queue-edit-test" }),
    signal: new AbortController().signal
  };
}

async function invoke<T>(handler: unknown, request: unknown): Promise<T> {
  if (typeof handler !== "function") throw new Error("RPC handler is missing.");
  return await (handler as (request: unknown, context: unknown) => Promise<T>)(request, context());
}

function completedRecord(id: string, kind: string, body: unknown, response: unknown): OperationRecord<unknown> {
  return {
    id,
    connectionId: connection.id,
    kind,
    body,
    bodyHash: operationBodyHash(body),
    completionMode: "transactional",
    status: "completed",
    response,
    createdAt: 1,
    updatedAt: 2,
    revision: 1n
  };
}

it("carries Host-owned Session fences through a public Queue edit and fences steer reordering", async () => {
  const sessionReferenceSnapshot = {
    mentionIndex: 0,
    sessionId: "source-session",
    throughCursor: "41",
    sourceGeneration: 3,
    historyBindingFingerprint: "sha256:history",
    historyMarkerCursor: "37",
    historyLeafId: "leaf-37"
  } as const;
  let durable: QueueItemRecord = {
    id: "queue-item",
    sessionId: "destination-session",
    runId: "queue-run",
    operationId: "send-queue-item",
    disposition: "follow_up",
    state: "accepted",
    bodyHash: "sha256:before",
    body: {
      text: "@Same",
      images: [],
      files: [],
      mentions: [{ kind: "session", label: "Same", reference: "source-session" }],
      mentionRanges: [{ start: 0, end: 5, mentionIndex: 0 }],
      sessionReferenceSnapshots: [sessionReferenceSnapshot],
      disposition: "follow_up"
    },
    position: 0,
    editLocked: true,
    createdAt: 1,
    updatedAt: 1,
    revision: 4n
  };
  const session = {
    revision: 2n,
    descriptor: {
      id: durable.sessionId,
      backendId: "backend",
      targetId: "target",
      title: "Destination",
      binding: { opaqueRef: "native:destination", generation: 2 },
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
      id: durable.runId,
      sessionId: durable.sessionId,
      source: "user" as const,
      state: "queued" as const,
      createdAt: 1
    }
  };
  const editQueueItem = vi.fn((input: { readonly body: QueueItemRecord["body"] }) => {
    durable = { ...durable, body: input.body, disposition: input.body.disposition, revision: 9n, updatedAt: 2 };
    return durable;
  });
  const reorderQueueItem = vi.fn(() => durable);
  const store = {
    findOperation: () => undefined,
    getQueueItem: () => durable,
    getSession: () => session,
    getRun: () => run,
    editQueueItem,
    reorderQueueItem
  };
  const canonicalQueueItemEdit = vi.fn((
    current: QueueItemRecord,
    proposed: QueueItemRecord["body"],
    textSplices: readonly { readonly start: number; readonly end: number; readonly replacementText: string }[]
  ) => {
    expect(current.body.sessionReferenceSnapshots).toEqual([sessionReferenceSnapshot]);
    expect(proposed.sessionReferenceSnapshots).toBeUndefined();
    expect(textSplices).toEqual([{ start: 0, end: 0, replacementText: "Review " }]);
    return { ...proposed, sessionReferenceSnapshots: current.body.sessionReferenceSnapshots };
  });
  const assertInputCapabilities = vi.fn();
  const sessionHost = {
    getSessionRuntimeControl: () => ({ effective: undefined }),
    recordUserSessionRuntimeSelection: () => 0,
    canonicalQueueItemEdit,
    assertInputCapabilities,
    mutate: async (input: {
      readonly operationId: string;
      readonly kind: string;
      readonly body: unknown;
      readonly commit: (transactionStore: {
        readonly getQueueItem: typeof store.getQueueItem;
        readonly getRun: typeof store.getRun;
        readonly editQueueItem: typeof editQueueItem;
        readonly reorderQueueItem: typeof reorderQueueItem;
      }) => unknown;
    }) => {
      const value = input.commit(store);
      return {
        replayed: false,
        value,
        operation: completedRecord(input.operationId, input.kind, input.body, value)
      };
    }
  };
  const application = {
    config: { publicOrigin: "https://orchestrator.example.test" },
    store,
    connections: { authenticate: () => connection },
    sessionHost,
    artifacts: {},
    blobTransfers: {},
    artifactRepository: {},
    workspaces: {},
    workspaceChanges: {},
    scheduler: {},
    adapters: [],
    browserActivity: [],
    close: async () => undefined
  } as unknown as OrchestratorApplication;
  const services = createConnectServices(application);
  const mutation = create(contract.OperationMutationSchema, {
    preconditions: [{
      entity: { kind: contract.EntityKind.QUEUE_ITEM, id: durable.id },
      expectedRevision: { value: durable.revision },
      expectedGeneration: 2n
    }],
    payload: {
      case: "editQueueItem",
      value: create(contract.EditQueueItemMutationSchema, {
        queueItemId: durable.id,
        input: create(contract.InputContentSchema, {
          parts: [
            { content: { case: "text", value: "Review @Same" } },
            { content: { case: "sessionMention", value: { sessionId: "source-session", displayText: "Same" } } }
          ],
          mentionRanges: [{ start: 7, end: 12, mentionIndex: 0 }]
        }),
        deliveryMode: contract.QueueDeliveryMode.STEER,
        lockToken: "edit-lock",
        textSplices: [{ start: 0, end: 0, replacementText: "Review " }]
      })
    }
  });

  const response = await invoke<contract.SubmitOperationResponse>(services.operation.submitOperation, {
    operationId: "edit-queue-operation",
    connectionId: connection.id,
    mutation
  });

  expect(response.operation?.state).toBe(contract.OperationState.SUCCEEDED);
  expect(canonicalQueueItemEdit).toHaveBeenCalledOnce();
  expect(assertInputCapabilities).toHaveBeenCalledWith(durable.sessionId, expect.objectContaining({
    text: "Review @Same",
    disposition: "steer",
    sessionReferenceSnapshots: [sessionReferenceSnapshot]
  }));
  expect(editQueueItem).toHaveBeenCalledWith(expect.objectContaining({
    queueItemId: durable.id,
    lockToken: "edit-lock",
    body: expect.objectContaining({ sessionReferenceSnapshots: [sessionReferenceSnapshot] })
  }));
  expect(reorderQueueItem).toHaveBeenCalledWith(expect.objectContaining({
    queueItemId: durable.id,
    editLockToken: "edit-lock",
    expectedRevision: 9n,
    placement: { edge: "first" }
  }));
});
