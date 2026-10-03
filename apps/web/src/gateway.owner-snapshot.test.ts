import { create, type MessageInitShape } from "@bufbuild/protobuf";
import type { Transport } from "@connectrpc/connect";
import {
  EventPayloadSchema, EventSchema, GetSnapshotResponseSchema, MessageRole, SessionState, SnapshotSchema,
  StreamEventsResponseSchema, type Event, type Snapshot
} from "@joko/contracts";
import { describe, expect, it, vi } from "vitest";
import { createOrchestratorGateway } from "./gateway.js";
import type { AppSnapshot } from "./model.js";

describe("owner snapshot Timeline retention", () => {
  it("keeps a durable live answer across a workspace refresh and retires replaced Session and service generations", async () => {
    const harness = ownerHarness();
    await harness.gateway.connect();
    try {
      await harness.emit(answer("answer-one", "Complete answer."));
      expect(harness.latest().timelineBySession.get("session-one")?.[0]?.text).toBe("Complete answer.");
      const reads = harness.reads();
      await harness.emit({ case: "workspaceDiffProduced", value: { turnId: "turn-one" } });
      await vi.waitFor(() => expect(harness.reads()).toBeGreaterThan(reads));
      expect(harness.latest().timelineBySession.get("session-one")?.[0]).toMatchObject({ text: "Complete answer.", streaming: false });
      expect(harness.requests.every((request) => request.scope.kind.case === "owner")).toBe(true);

      harness.replaceSession(4n);
      await harness.gateway.refresh();
      expect(harness.latest().timelineBySession.has("session-one")).toBe(false);
      await harness.emit(answer("answer-two", "New generation."), 4n);
      harness.replaceSession(undefined);
      await harness.gateway.refresh();
      expect(harness.latest().timelineBySession.has("session-one")).toBe(false);
      harness.replaceSession(4n);
      await harness.emit(answer("answer-three", "Retained until service replacement."), 4n);
      harness.replaceService(8n);
      await harness.gateway.refresh();
      expect(harness.latest().timelineBySession.has("session-one")).toBe(false);
    } finally { harness.gateway.disconnect(); }
  });

  it.each([
    { case: "messageDeleted", value: { productSessionId: "session-one", requestedEventId: "answer-one", deletedEventIds: ["answer-one"] } },
    { case: "sessionReset", value: { productSessionId: "session-one" } },
    { case: "historyPruned", value: { productSessionId: "session-one" } },
    { case: "nativeSessionChanged", value: { productSessionId: "session-one", opaqueNativeReference: "new-reference" } },
    { case: "nativeBranchChanged", value: { productSessionId: "session-one", timelineRebuilt: true } }
  ] satisfies EventKind[])("does not restore a retired Timeline after $case", async (boundary) => {
    const harness = ownerHarness();
    await harness.gateway.connect();
    try {
      await harness.emit(answer("answer-one", "Retired answer."));
      const reads = harness.reads();
      await harness.emit(boundary);
      await vi.waitFor(() => expect(harness.reads()).toBeGreaterThan(reads));
      expect(harness.latest().timelineBySession.has("session-one")).toBe(false);
      await harness.gateway.refresh();
      expect(harness.latest().timelineBySession.has("session-one")).toBe(false);
    } finally { harness.gateway.disconnect(); }
  });

  it.each(["gap", "projectionInvalidated"] as const)("invalidates loaded history when %s retires an unknown stream prefix", async (boundary) => {
    const harness = ownerHarness();
    await harness.gateway.connect();
    try {
      await harness.emit(answer("answer-one", "Unknown prefix."));
      const reads = harness.reads();
      await harness.emit(boundary === "gap"
        ? { case: "workspaceDiffProduced", value: { turnId: "turn-one" } }
        : { case: "projectionInvalidated", value: {} }, 3n, boundary === "gap" ? 2n : 1n);
      await vi.waitFor(() => expect(harness.reads()).toBeGreaterThan(reads));
      expect(harness.latest().timelineBySession.has("session-one")).toBe(false);
      expect(harness.latest().timelineHistoryRevisionBySession.get("session-one")).toBeGreaterThan(0n);
    } finally { harness.gateway.disconnect(); }
  });
});

type EventKind = NonNullable<MessageInitShape<typeof EventPayloadSchema>["kind"]>;
function answer(messageId: string, text: string): EventKind {
  return { case: "messageCompleted", value: { messageId, role: MessageRole.ASSISTANT,
    blocks: [{ content: { case: "text", value: text } }] } };
}

function ownerHarness() {
  let generation = 7n;
  let sequence = 0n;
  let sessionGeneration: bigint | undefined = 3n;
  let snapshotReads = 0;
  const snapshots: AppSnapshot[] = [];
  const requests: any[] = [];
  const events: Event[] = [];
  let wake: (() => void) | undefined;
  const rawSnapshot = (): Snapshot => create(SnapshotSchema, { generation,
    resumeCursor: { generation, sequence }, timeline: [],
    sessions: sessionGeneration === undefined ? [] : [{ sessionId: "session-one", backendId: "backend-one",
      targetId: "target-one", state: SessionState.IDLE, location: { kind: { case: "serviceNode", value: {} } },
      nativeBinding: { runtimeGeneration: sessionGeneration } }]
  });
  const transport = {
    unary: vi.fn(async (method: any, _signal: unknown, _timeout: unknown, _headers: unknown, input: any) => {
      if (method.localName !== "getSnapshot") throw new Error(`Unexpected method: ${method.localName}`);
      requests.push(input); snapshotReads += 1;
      return response(method, create(GetSnapshotResponseSchema, { snapshot: rawSnapshot() }));
    }),
    stream: vi.fn(async (method: any, signal: AbortSignal) => response(method, stream(signal), true))
  } as unknown as Transport;
  async function* stream(signal: AbortSignal) {
    const aborted = (): void => wake?.();
    signal.addEventListener("abort", aborted);
    try {
      while (!signal.aborted) {
        const event = events.shift();
        if (event !== undefined) yield create(StreamEventsResponseSchema, { event });
        else await new Promise<void>((resolve) => { wake = resolve; });
      }
    } finally { signal.removeEventListener("abort", aborted); }
  }
  const gateway = createOrchestratorGateway({ id: "connection-one", deviceId: "device-one", serverId: "server-one",
    name: "Browser", origin: "https://orchestrator.example" }, "test-credential", {
      onSnapshot: (snapshot) => snapshots.push(snapshot)
    }, () => transport);
  return { gateway, requests, reads: () => snapshotReads, latest: () => snapshots.at(-1)!,
    replaceSession: (next: bigint | undefined) => { sessionGeneration = next; },
    replaceService: (next: bigint) => { generation = next; sequence = 0n; },
    emit: async (kind: EventKind, runtimeGeneration = sessionGeneration ?? 3n, sequenceStep = 1n): Promise<void> => {
      sequence += sequenceStep;
      const target = sequence;
      events.push(create(EventSchema, { eventId: `event-${generation}-${sequence}`, cursor: { generation, sequence },
        identity: { sessionId: "session-one", generation: runtimeGeneration }, payload: { kind } }));
      wake?.();
      await vi.waitFor(() => expect(snapshots.at(-1)?.cursor).toBeGreaterThanOrEqual(target));
    }
  };
}

function response(method: any, message: unknown, stream = false): any {
  return { stream, service: method.parent, method, header: new Headers(), trailer: new Headers(), message };
}
