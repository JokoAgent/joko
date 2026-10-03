import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, type Transport } from "@connectrpc/connect";
import {
  BeginBlobUploadResponseSchema,
  CompleteBlobUploadResponseSchema,
  EntityKind,
  EventSchema,
  GetSnapshotResponseSchema,
  ListManagedModelRuntimesResponseSchema,
  ListSessionTimelineResponseSchema,
  MessageRole,
  OperationState,
  SnapshotSchema,
  StreamEventsResponseSchema,
  SubmitOperationResponseSchema,
  type Event,
  type SubmitOperationRequest
} from "@joko/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOrchestratorGateway } from "./gateway.js";
import type { AppSnapshot, ComposerDraft, ConnectionProfile } from "./model.js";

describe("input preparation and admission", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("keeps the source generation through delayed attachment reads, snapshot changes, and response retry", async () => {
    let generation = 4n;
    let snapshot: AppSnapshot | undefined;
    const submissions: SubmitOperationRequest[] = [];
    const uploads = vi.fn(async () => new Response(undefined, { status: 204 }));
    vi.stubGlobal("fetch", uploads);
    const transport = {
      unary: vi.fn(async (method: any, _signal: unknown, _timeout: unknown, _headers: unknown, input: any) => {
        let message: unknown;
        switch (method.localName) {
          case "getSnapshot": message = create(GetSnapshotResponseSchema, { snapshot: create(SnapshotSchema, {
            generation: 1n,
            sessions: [{
              sessionId: "task",
              location: { kind: { case: "serviceNode", value: {} } },
              nativeBinding: { runtimeGeneration: generation }
            }]
          }) }); break;
          case "listManagedModelRuntimes": message = create(ListManagedModelRuntimesResponseSchema); break;
          case "beginBlobUpload": message = create(BeginBlobUploadResponseSchema, {
            upload: { uploadId: "upload", ticket: { relativeEndpoint: "/v1/blob-uploads/ticket" } }
          }); break;
          case "completeBlobUpload": message = create(CompleteBlobUploadResponseSchema, {
            blob: { blobId: "attachment", fileName: "note.txt", mediaType: "text/plain", byteSize: 4n }
          }); break;
          case "submitOperation":
            submissions.push(input);
            if (submissions.length === 1) throw new ConnectError("Accepted response was lost", Code.Unavailable);
            message = create(SubmitOperationResponseSchema, { operation: { operationId: input.operationId, state: OperationState.SUCCEEDED } });
            break;
          default: throw new Error(`Unexpected RPC ${method.localName}`);
        }
        return { stream: false, service: method.parent, method, header: new Headers(), trailer: new Headers(), message };
      }),
      stream: vi.fn(async (method: any) => ({ stream: true, service: method.parent, method,
        header: new Headers(), trailer: new Headers(), message: idleStream() }))
    } as unknown as Transport;
    const gateway = createOrchestratorGateway({ id: "connection", deviceId: "device", serverId: "server", name: "Browser",
      origin: "https://orchestrator.example" }, "secret", { onSnapshot: value => { snapshot = value; } }, () => transport);
    await gateway.connect();
    const file = new File(["note"], "note.txt", { type: "text/plain" });
    let release!: (bytes: ArrayBuffer) => void;
    const read = vi.spyOn(file, "arrayBuffer").mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const draft: ComposerDraft = { text: "Review", attachments: [{ id: "local", kind: "file", file }], mentions: [], deliveryMode: "prompt" };
    await expect(gateway.send("task", draft, { expectedGeneration: 0n })).rejects.toThrow("source task generation");
    expect(read).not.toHaveBeenCalled();
    const admission = { expectedGeneration: generation };
    const pending = gateway.send("task", draft, admission);
    expect(read).toHaveBeenCalledOnce();
    expect(submissions).toEqual([]);
    generation = 5n;
    admission.expectedGeneration = generation;
    await gateway.refresh();
    expect(snapshot?.sessions[0]?.generation).toBe(5n);
    release(new TextEncoder().encode("note").buffer);
    await pending;
    expect(uploads).toHaveBeenCalledOnce();
    expect(submissions).toHaveLength(2);
    expect(submissions[0]?.operationId).toBe(submissions[1]?.operationId);
    for (const submission of submissions) {
      expect(submission.mutation?.preconditions).toMatchObject([{ entity: { kind: EntityKind.SESSION, id: "task" }, expectedGeneration: 4n }]);
      expect(submission.mutation?.preconditions[0]?.expectedRevision).toBeUndefined();
    }
    gateway.disconnect();
  });

  it("recognizes local input before admission returns, through uncertain retry and exact-scope history reloads", async () => {
    const profile: ConnectionProfile = { id: "unread-origin", deviceId: "device", serverId: "origin-server",
      name: "Browser", origin: "https://origin.example" };
    const generation = 4n;
    const events: Event[] = [];
    const submissions: SubmitOperationRequest[] = [];
    const attempts: { resolve: (value: unknown) => void; reject: (error: unknown) => void }[] = [];
    const feed = eventFeed();
    const gateways: ReturnType<typeof createOrchestratorGateway>[] = [];
    let snapshot: AppSnapshot | undefined;
    const transportFor = (history: readonly Event[], live = false): Transport => ({
      unary: vi.fn(async (method: any, _signal: unknown, _timeout: unknown, _headers: unknown, input: any) => {
        let message: unknown;
        switch (method.localName) {
          case "getSnapshot": message = create(GetSnapshotResponseSchema, { snapshot: create(SnapshotSchema, {
            generation: 1n,
            resumeCursor: { generation: 1n, sequence: history.at(-1)?.cursor?.sequence ?? 0n },
            sessions: [{ sessionId: "task", location: { kind: { case: "serviceNode", value: {} } },
              nativeBinding: { runtimeGeneration: generation } }],
            timeline: [...history]
          }) }); break;
          case "listManagedModelRuntimes": message = create(ListManagedModelRuntimesResponseSchema); break;
          case "listSessionTimeline": message = create(ListSessionTimelineResponseSchema, {
            events: history.filter(event => event.identity?.sessionId === input.sessionId)
          }); break;
          case "submitOperation":
            submissions.push(input);
            message = await new Promise((resolve, reject) => { attempts.push({ resolve, reject }); });
            break;
          default: throw new Error(`Unexpected RPC ${method.localName}`);
        }
        return { stream: false, service: method.parent, method, header: new Headers(), trailer: new Headers(), message };
      }),
      stream: vi.fn(async (method: any, signal: AbortSignal) => ({ stream: true, service: method.parent, method,
        header: new Headers(), trailer: new Headers(), message: live ? feed.responses(signal) : eventFeed().responses(signal) }))
    }) as unknown as Transport;
    const transport = transportFor(events, true);
    const gateway = createOrchestratorGateway(profile, "test-key", { onSnapshot: value => { snapshot = value; } }, () => transport);
    gateways.push(gateway);
    const userStarted = (operationId: string, sessionId = "task", eventGeneration = generation): Event => create(EventSchema, {
      eventId: `started-${sessionId}-${eventGeneration}`,
      cursor: { generation: 1n, sequence: 1n },
      identity: { sessionId, generation: eventGeneration, operationId },
      payload: { kind: { case: "messageStarted", value: { messageId: "input", role: MessageRole.USER,
        userInputAccepted: true, userInput: { parts: [{ content: { case: "text", value: "Fixture input" } }] } } } }
    });
    try {
      await gateway.connect();
      const pending = gateway.send("task", { text: "Fixture input", attachments: [], mentions: [], deliveryMode: "prompt" },
        { expectedGeneration: generation });
      await vi.waitFor(() => expect(submissions).toHaveLength(1));
      const operationId = submissions[0]!.operationId;
      const started = userStarted(operationId);
      events.push(started);
      feed.push(started);
      await vi.waitFor(() => expect(snapshot?.timelineBySession.get("task")?.[0]).toMatchObject({
        inputOperationId: operationId, localUserInput: true
      }));
      const completed = create(EventSchema, { eventId: "completed-input", cursor: { generation: 1n, sequence: 2n },
        identity: { sessionId: "task", generation, operationId },
        payload: { kind: { case: "messageCompleted", value: { messageId: "input", role: MessageRole.USER,
          blocks: [{ content: { case: "text", value: "Fixture input" } }] } } } });
      events.push(completed);
      feed.push(completed);
      await vi.waitFor(() => expect(snapshot?.timelineBySession.get("task")?.[0]).toMatchObject({
        inputOperationId: operationId, localUserInput: true, sourceEventId: completed.eventId, streaming: false
      }));
      await gateway.refresh();
      expect(snapshot?.timelineBySession.get("task")?.[0]).toMatchObject({ inputOperationId: operationId, localUserInput: true });
      expect((await gateway.loadSessionTimelinePage("task")).items[0]).toMatchObject({ inputOperationId: operationId, localUserInput: true });
      expect((await gateway.loadSessionTimelineAround("task", completed.eventId))[0]).toMatchObject({ inputOperationId: operationId, localUserInput: true });
      attempts[0]!.reject(new ConnectError("Accepted response was lost", Code.Unavailable));
      await vi.waitFor(() => expect(submissions).toHaveLength(2));
      expect(submissions[1]!.operationId).toBe(operationId);
      expect((await gateway.loadSessionTimelinePage("task")).items[0]).toMatchObject({ inputOperationId: operationId, localUserInput: true });
      attempts[1]!.resolve(create(SubmitOperationResponseSchema, { operation: { operationId, state: OperationState.SUCCEEDED } }));
      await pending;
      gateway.disconnect();

      const scopes = [
        { name: "same connection after reconnect", profile, sessionId: "task", generation, operationId, local: true },
        { name: "other profile", profile: { ...profile, id: "other-profile" }, sessionId: "task", generation, operationId, local: false },
        { name: "other server", profile: { ...profile, serverId: "other-server" }, sessionId: "task", generation, operationId, local: false },
        { name: "other origin", profile: { ...profile, origin: "https://other.example" }, sessionId: "task", generation, operationId, local: false },
        { name: "other session", profile, sessionId: "other-task", generation, operationId, local: false },
        { name: "other generation", profile, sessionId: "task", generation: generation + 1n, operationId, local: false },
        { name: "foreign operation", profile, sessionId: "task", generation, operationId: "foreign-operation", local: false }
      ];
      for (const scope of scopes) {
        const history = [userStarted(scope.operationId, scope.sessionId, scope.generation)];
        const scopedTransport = transportFor(history);
        let scopedSnapshot: AppSnapshot | undefined;
        const scopedGateway = createOrchestratorGateway(scope.profile, "test-key", {
          onSnapshot: value => { scopedSnapshot = value; }
        }, () => scopedTransport);
        gateways.push(scopedGateway);
        await scopedGateway.connect();
        const rows = [scopedSnapshot?.timelineBySession.get(scope.sessionId)?.[0],
          (await scopedGateway.loadSessionTimelinePage(scope.sessionId)).items[0],
          (await scopedGateway.loadSessionTimelineAround(scope.sessionId, history[0]!.eventId))[0]];
        for (const row of rows) {
          expect(row?.inputOperationId, scope.name).toBe(scope.operationId);
          expect(row?.localUserInput === true, scope.name).toBe(scope.local);
        }
        scopedGateway.disconnect();
      }
    } finally {
      for (const active of gateways) active.disconnect();
    }
  });
});

async function* idleStream(): AsyncIterable<never> {
  await new Promise<never>(() => undefined);
}

function eventFeed() {
  const queued: Event[] = [];
  let wake: (() => void) | undefined;
  return {
    push(event: Event): void { queued.push(event); wake?.(); },
    async *responses(signal: AbortSignal) {
      while (!signal.aborted) {
        if (queued.length === 0) {
          await new Promise<void>(resolve => {
            wake = () => resolve();
            signal.addEventListener("abort", wake, { once: true });
          });
          signal.removeEventListener("abort", wake!);
          wake = undefined;
        }
        if (signal.aborted) return;
        const event = queued.shift();
        if (event !== undefined) yield create(StreamEventsResponseSchema, { event });
      }
    }
  };
}
