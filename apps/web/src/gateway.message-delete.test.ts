import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { Code, ConnectError, type Transport } from "@connectrpc/connect";
import {
  EntityKind,
  EntityVersionSchema,
  EventPayloadSchema,
  EventSchema,
  GetSnapshotResponseSchema,
  MessageRole,
  OperationResultSchema,
  OperationSchema,
  OperationState,
  SessionState,
  StreamEventsResponseSchema,
  SubmitOperationResponseSchema,
  WatchOperationResponseSchema,
  type Event,
  type SubmitOperationRequest
} from "@joko/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOrchestratorGateway } from "./gateway.js";
import type { AppSnapshot } from "./model.js";

const sessionId = "session-one";
const eventId = "event-assistant-complete";
const connectionId = "connection-delete";

describe("message deletion gateway", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("adopts the durable receipt while its catalog refresh is pending and handles refresh failure independently", async () => {
    const view = harness(true);
    const refresh = deferred<void>();
    await view.gateway.connect();
    try {
      await view.answer(sessionId, eventId, "Deleted answer");
      await view.answer("other-session", "other-event", "Another task's answer");
      await expect(view.gateway.deleteSessionMessage(sessionId, eventId, 2n)).rejects.toThrow("generation is no longer current");
      expect(view.submissions).toHaveLength(0);
      view.beforeNextSnapshot(() => refresh.promise);
      const deletion = view.gateway.deleteSessionMessage(sessionId, eventId, 3n);
      const settled = vi.fn();
      void deletion.then(() => settled("succeeded"), settled);
      await vi.waitFor(() => expect(view.submissions).toHaveLength(1));
      expect(view.latest().timelineBySession.get(sessionId)?.[0]?.sourceEventId).toBe(eventId);
      expect(view.latest().timelineHistoryRevisionBySession.has(sessionId)).toBe(false);
      expect(view.submissions[0]?.mutation?.payload).toMatchObject({
        case: "deleteSessionMessage", value: { sessionId, eventId }
      });
      expect(view.submissions[0]?.mutation?.preconditions).toMatchObject([
        { entity: { kind: EntityKind.SESSION, id: sessionId }, expectedGeneration: 3n }
      ]);

      view.complete();
      await vi.waitFor(() => expect(settled).toHaveBeenCalledExactlyOnceWith("succeeded"));
      await vi.waitFor(() => expect(view.snapshotReads()).toBe(2));
      const revision = view.latest().timelineHistoryRevisionBySession.get(sessionId);
      expect(revision).toBeGreaterThan(0n);
      expect(view.latest().timelineBySession.has(sessionId)).toBe(false);
      expect(view.latest().timelineBySession.get("other-session")?.[0]?.text).toBe("Another task's answer");

      refresh.reject(new ConnectError("Temporary catalog failure", Code.Internal));
      await vi.waitFor(() => expect(view.errors).toEqual(["Temporary catalog failure"]));
      await view.answer(sessionId, "buffered-deleted-output", "Old buffered output from the deleted turn");
      expect(view.latest().timelineBySession.has(sessionId)).toBe(false);
      await view.deletionEvent();
      expect(view.latest().timelineHistoryRevisionBySession.get(sessionId)).toBe(revision);
      await view.answer(sessionId, "later-event", "A later answer");
      expect(view.latest().timelineBySession.get(sessionId)?.map((item) => item.text)).toEqual(["A later answer"]);
      expect(view.submissions).toHaveLength(1);
    } finally { refresh.resolve(); view.gateway.disconnect(); }
  });

  it("retains a newer streamed row when the exact deletion event arrived before its receipt", async () => {
    const view = harness();
    await view.gateway.connect();
    try {
      await view.answer(sessionId, eventId, "Deleted answer");
      const deletion = view.gateway.deleteSessionMessage(sessionId, eventId);
      await vi.waitFor(() => expect(view.submissions).toHaveLength(1));
      await view.deletionEvent();
      const revision = view.latest().timelineHistoryRevisionBySession.get(sessionId);
      expect(revision).toBeGreaterThan(0n);
      expect(view.latest().timelineMessageDeletionBySession?.get(sessionId)).toEqual({
        previousRevision: 0n, revision, eventIds: [eventId, "buffered-deleted-output"]
      });
      await view.answer(sessionId, "later-event", "A later answer");

      view.complete();
      await expect(deletion).resolves.toBeUndefined();
      expect(view.latest().timelineHistoryRevisionBySession.get(sessionId)).toBe(revision);
      expect(view.latest().timelineBySession.get(sessionId)?.map((item) => item.text)).toEqual(["A later answer"]);
      expect(view.submissions).toHaveLength(1);
    } finally { view.gateway.disconnect(); }
  });

  it("accepts new output after reconnecting at an authoritative cursor that covers the receipt", async () => {
    const view = harness();
    await view.gateway.connect();
    try {
      await view.answer(sessionId, eventId, "Deleted answer");
      const deletion = view.gateway.deleteSessionMessage(sessionId, eventId);
      await vi.waitFor(() => expect(view.submissions).toHaveLength(1));
      const coveredCursor = view.coverDeletionInSnapshot();
      view.complete();
      await deletion;
      await vi.waitFor(() => expect(view.latest().cursor).toBe(coveredCursor));
      view.closeEventStream();
      await vi.waitFor(() => expect(view.streamCursors).toEqual([0n, coveredCursor]));
      await view.answer(sessionId, "later-event", "New output after reconnect");
      expect(view.latest().timelineBySession.get(sessionId)?.map((item) => item.text)).toEqual(["New output after reconnect"]);
    } finally { view.gateway.disconnect(); }
  });

  it("accepts later output on the same stream after its cursor passes the verified deletion", async () => {
    const view = harness();
    await view.gateway.connect();
    try {
      await view.answer(sessionId, eventId, "Deleted answer");
      const deletion = view.gateway.deleteSessionMessage(sessionId, eventId);
      await vi.waitFor(() => expect(view.submissions).toHaveLength(1));
      const coveredCursor = view.coverDeletionInSnapshot();
      view.complete();
      await deletion;
      await vi.waitFor(() => expect(view.latest().cursor).toBe(coveredCursor));
      await view.answer(sessionId, "resync-edge", "First output at the stream gap");
      await view.answer(sessionId, "later-event", "New output on the original stream");
      expect(view.latest().timelineBySession.get(sessionId)?.map((item) => item.text)).toEqual(["New output on the original stream"]);
      expect(view.streamCursors).toEqual([0n]);
    } finally { view.gateway.disconnect(); }
  });

  it("leaves a replacement Session generation's projection alone when the old receipt arrives", async () => {
    const view = harness();
    await view.gateway.connect();
    try {
      await view.answer(sessionId, eventId, "Deleted answer");
      const deletion = view.gateway.deleteSessionMessage(sessionId, eventId);
      await vi.waitFor(() => expect(view.submissions).toHaveLength(1));
      await view.replaceSessionGeneration();
      await view.answer(sessionId, "later-event", "Output from the replacement");

      view.complete();
      await expect(deletion).resolves.toBeUndefined();
      expect(view.latest().timelineHistoryRevisionBySession.has(sessionId)).toBe(false);
      expect(view.latest().timelineBySession.get(sessionId)?.map((item) => item.text)).toEqual(["Output from the replacement"]);
    } finally { view.gateway.disconnect(); }
  });

  it.each([
    { operationId: "wrong-operation" },
    { connectionId: "wrong-connection" },
    { mutation: { payload: { case: "deleteSessionMessage", value: { sessionId: "other-session", eventId } } } },
    { mutation: { payload: { case: "deleteSessionMessage", value: { sessionId, eventId: "other-event" } } } },
    { version: undefined },
    { result: { payload: { case: "acknowledgement", value: { accepted: false } } } }
  ] satisfies readonly MessageInitShape<typeof OperationSchema>[])("keeps the current transcript for an unconfirmed receipt %#", async (receipt) => {
    const view = harness();
    await view.gateway.connect();
    try {
      await view.answer(sessionId, eventId, "Keep this answer");
      const deletion = view.gateway.deleteSessionMessage(sessionId, eventId);
      await vi.waitFor(() => expect(view.submissions).toHaveLength(1));
      const rejected = expect(deletion).rejects.toMatchObject({ code: "RESULT_UNKNOWN" });
      view.complete(receipt);
      await rejected;
      expect(view.latest().timelineBySession.get(sessionId)?.[0]?.sourceEventId).toBe(eventId);
      expect(view.latest().timelineHistoryRevisionBySession.has(sessionId)).toBe(false);
    } finally { view.gateway.disconnect(); }
  });

  it("reports a real terminal failure without retiring the selected transcript", async () => {
    const view = harness();
    await view.gateway.connect();
    try {
      await view.answer(sessionId, eventId, "Keep this answer");
      const deletion = view.gateway.deleteSessionMessage(sessionId, eventId);
      await vi.waitFor(() => expect(view.submissions).toHaveLength(1));
      const rejected = expect(deletion).rejects.toThrow("The original message was not deleted.");
      view.complete({ state: OperationState.FAILED, error: { message: "The original message was not deleted." } });
      await rejected;
      expect(view.latest().timelineBySession.get(sessionId)?.[0]?.sourceEventId).toBe(eventId);
      expect(view.latest().timelineHistoryRevisionBySession.has(sessionId)).toBe(false);
    } finally { view.gateway.disconnect(); }
  });
});

type EventKind = NonNullable<MessageInitShape<typeof EventPayloadSchema>["kind"]>;

function harness(directReceipt = false) {
  vi.stubGlobal("window", {
    location: { href: "https://joko.test/#/tasks/current" },
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout
  });
  const submissions: SubmitOperationRequest[] = [];
  const snapshots: AppSnapshot[] = [];
  const errors: string[] = [];
  const streamCursors: bigint[] = [];
  const streamQueue: (Event | "closed")[] = [];
  const terminal = deferred<MessageInitShape<typeof OperationSchema>>();
  let notifyStream: (() => void) | undefined;
  let beforeSnapshot: (() => Promise<void>) | undefined;
  let reads = 0;
  let sequence = 0n;
  let storeRevision = 1n;
  let sessionGeneration = 3n;
  const transport = {
    unary: vi.fn(async (method: any, _signal: unknown, _timeout: unknown, _headers: unknown, input: any) => {
      if (method.localName === "getSnapshot") {
        reads += 1;
        const before = beforeSnapshot;
        beforeSnapshot = undefined;
        await before?.();
        return response(method, create(GetSnapshotResponseSchema, { snapshot: {
          generation: 1n, revision: { value: storeRevision }, resumeCursor: { generation: 1n, sequence },
          sessions: [sessionId, "other-session"].map((id) => ({ sessionId: id, backendId: "backend", targetId: "target",
            state: SessionState.IDLE, nativeBinding: { runtimeGeneration: sessionGeneration }, location: { kind: { case: "serviceNode" as const, value: {} } } }))
        } }));
      }
      if (method.localName === "submitOperation") {
        submissions.push(input);
        return response(method, create(SubmitOperationResponseSchema, {
          operation: directReceipt ? await terminal.promise
            : { operationId: input.operationId, connectionId: input.connectionId, mutation: input.mutation, state: OperationState.RUNNING }
        }));
      }
      throw new Error(`Unexpected method: ${method.localName}`);
    }),
    stream: vi.fn(async (method: any, signal: AbortSignal, _timeout: unknown, _headers: unknown, input: any) => {
      if (method.localName === "watchOperation") return response(method, watchOperation(), true);
      if (method.localName !== "streamEvents") throw new Error(`Unexpected stream: ${method.localName}`);
      streamCursors.push(input.afterCursor?.sequence ?? 0n);
      return response(method, streamEvents(signal), true);
    })
  } as unknown as Transport;
  const gateway = createOrchestratorGateway(
    { id: connectionId, deviceId: "device-test", name: "Browser", origin: "https://orchestrator.example", serverId: "server-test" },
    "secret", { onSnapshot: (snapshot) => snapshots.push(snapshot), onError: (error) => errors.push(error.message) }, () => transport
  );

  async function* watchOperation() {
    yield create(WatchOperationResponseSchema, { operation: await terminal.promise });
  }
  async function* streamEvents(signal: AbortSignal) {
    const wake = () => notifyStream?.();
    signal.addEventListener("abort", wake, { once: true });
    try {
      yield create(StreamEventsResponseSchema);
      while (!signal.aborted) {
        const event = streamQueue.shift();
        if (event === "closed") return;
        if (event !== undefined) yield create(StreamEventsResponseSchema, { event });
        else await new Promise<void>((resolve) => { notifyStream = resolve; });
      }
    } finally {
      notifyStream = undefined;
      signal.removeEventListener("abort", wake);
    }
  }

  const latest = () => snapshots.at(-1)!;
  const emit = async (sourceSessionId: string, sourceEventId: string, kind: EventKind, operationId?: string): Promise<void> => {
    const cursor = ++sequence;
    streamQueue.push(create(EventSchema, { eventId: sourceEventId, cursor: { generation: 1n, sequence: cursor },
      identity: { sessionId: sourceSessionId, generation: sessionGeneration, operationId }, payload: { kind } }));
    notifyStream?.();
    await vi.waitFor(() => expect(latest().cursor).toBe(cursor));
  };
  return {
    gateway, submissions, errors, latest, streamCursors, snapshotReads: () => reads,
    beforeNextSnapshot: (before: () => Promise<void>) => { beforeSnapshot = before; },
    complete: (receipt: MessageInitShape<typeof OperationSchema> = {}) => {
      const request = submissions[0]!;
      terminal.resolve({ operationId: request.operationId, connectionId: request.connectionId, mutation: request.mutation,
        state: OperationState.SUCCEEDED,
        result: create(OperationResultSchema, { payload: { case: "acknowledgement", value: { accepted: true } } }),
        version: create(EntityVersionSchema, { revision: { value: 5n } }), ...receipt });
    },
    answer: (sourceSessionId: string, sourceEventId: string, text: string) => emit(sourceSessionId, sourceEventId, { case: "messageCompleted", value: {
      messageId: sourceEventId, role: MessageRole.ASSISTANT, blocks: [{ content: { case: "text", value: text } }]
    } }),
    deletionEvent: () => emit(sessionId, "durable-delete-boundary", { case: "messageDeleted", value: {
      productSessionId: sessionId, requestedEventId: eventId, deletedEventIds: [eventId, "buffered-deleted-output"]
    } }, submissions[0]?.operationId),
    coverDeletionInSnapshot: () => { storeRevision = 5n; return ++sequence; },
    replaceSessionGeneration: () => { sessionGeneration += 1n; return gateway.refresh(); },
    closeEventStream: () => { streamQueue.push("closed"); notifyStream?.(); }
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, deny) => { resolve = accept; reject = deny; });
  return { promise, resolve, reject };
}

function response(method: any, message: unknown, stream = false): any {
  return { stream, service: method.parent, method, header: new Headers(), trailer: new Headers(), message };
}
