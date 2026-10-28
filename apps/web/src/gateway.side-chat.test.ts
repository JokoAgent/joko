import { create } from "@bufbuild/protobuf";
import type { Transport } from "@connectrpc/connect";
import { EntityKind, GetOperationResponseSchema, GetSnapshotResponseSchema, OperationSchema, OperationState,
  SessionDerivationKind, SessionSchema, SessionState, SnapshotSchema, SubmitOperationResponseSchema } from "@joko/contracts";
import { expect, it, vi } from "vitest";
import { createOrchestratorGateway } from "./gateway.js";
import type { AppSnapshot, PendingSideChatDraft } from "./model.js";

const record: PendingSideChatDraft = { operationId: "original-side-chat", sourceSessionId: "source", sourceGeneration: "3", backendId: "native", targetId: "project" };
function fixture(mode = "valid") {
  const child = create(SessionSchema, { sessionId: "child", backendId: mode === "backend" ? "foreign" : "native", targetId: "project", state: SessionState.IDLE,
    location: { kind: { case: "serviceNode", value: {} } },
    nativeBinding: { opaqueReference: "native-child", runtimeGeneration: mode === "generation" ? 2n : 1n },
    derivationOrigin: { kind: SessionDerivationKind.FORK, sideChat: true, sourceSessionId: mode === "source" ? "foreign" : "source",
      sourceMessageId: "completed-source-message", sourceEventId: "completed-source-event", sourceSessionAvailable: true, sourceMessageAvailable: true } });
  const operation = create(OperationSchema, { operationId: record.operationId, connectionId: "connection", state: OperationState.SUCCEEDED,
    mutation: { payload: { case: "openSideChat", value: { sourceSessionId: "source" } }, preconditions: [{ entity: { kind: EntityKind.SESSION, id: "source" },
      expectedGeneration: mode === "original-generation" ? 4n : 3n }] }, result: { payload: { case: "session", value: child } } });
  const submissions: unknown[] = [];
  const snapshots: AppSnapshot[] = [];
  const transport = {
    unary: vi.fn(async (method: any, _signal: unknown, _timeout: unknown, _headers: unknown, input: any) => {
      if (method.localName === "getSnapshot") return response(method, create(GetSnapshotResponseSchema, { snapshot: create(SnapshotSchema, {
        generation: 1n, resumeCursor: { generation: 1n, sequence: 0n }, sessions: [child]
      }) }));
      if (method.localName === "getOperation") { expect(input.operationId).toBe(record.operationId); return response(method, create(GetOperationResponseSchema, { operation })); }
      if (method.localName === "submitOperation") { submissions.push(input); return response(method, create(SubmitOperationResponseSchema, { operation })); }
      throw new Error(`Unexpected method: ${method.localName}`);
    }), stream: vi.fn(async (method: any) => response(method, idle(), true))
  } as unknown as Transport;
  const gateway = createOrchestratorGateway({ id: "connection", deviceId: "device", serverId: "node", name: "Node", origin: "https://side-chat.example" }, "secret",
    { onSnapshot: snapshot => { snapshots.push(snapshot); } }, () => transport);
  return { gateway, submissions, snapshots };
}

it("awaits durable client recovery before dispatching the exact Side Chat operation", async () => {
  const f = fixture(); let release!: () => void; const saved = new Promise<void>(resolve => { release = resolve; });
  const beforeDispatch = vi.fn(async (id: string) => { expect(id).toBe(record.operationId); await saved; });
  try {
    await f.gateway.connect();
    const opening = f.gateway.openSideChat("source", 3n, { operationId: record.operationId, beforeDispatch });
    await vi.waitFor(() => expect(beforeDispatch).toHaveBeenCalledOnce()); expect(f.submissions).toEqual([]);
    release(); await expect(opening).resolves.toBe("child");
    expect(f.submissions).toMatchObject([{ operationId: record.operationId, mutation: { payload: { case: "openSideChat", value: { sourceSessionId: "source" } },
      preconditions: [{ expectedGeneration: 3n }] } }]);
    expect(JSON.stringify(f.submissions, (_key, value) => typeof value === "bigint" ? value.toString() : value)).not.toContain("quote");
  } finally { release(); f.gateway.disconnect(); }
});

it("does not dispatch when the original client recovery cannot be saved", async () => {
  const f = fixture();
  try {
    await f.gateway.connect();
    await expect(f.gateway.openSideChat("source", 3n, { operationId: record.operationId, beforeDispatch: async () => { throw new Error("local save failed"); } })).rejects.toThrow("local save failed");
    expect(f.submissions).toEqual([]);
  } finally { f.gateway.disconnect(); }
});

it.each(["valid", "source", "backend", "generation", "original-generation"])("recovers only the original generation and exact typed child lineage: %s", async mode => {
  const f = fixture(mode);
  try {
    await f.gateway.connect();
    const reading = f.gateway.readSideChatOperation!(record);
    if (mode === "valid") {
      await expect(reading).resolves.toEqual({ state: "succeeded", sessionId: "child" });
      expect(f.snapshots.at(-1)?.sessions[0]).toMatchObject({ id: "child", backendId: record.backendId, targetId: record.targetId, generation: 1n,
        derivationOrigin: { kind: "fork", sideChat: true, sourceSessionId: record.sourceSessionId,
          sourceMessageId: "completed-source-message", sourceEventId: "completed-source-event", sourceSessionAvailable: true, sourceMessageAvailable: true } });
    }
    else await expect(reading).rejects.toThrow(/original|exact/u);
    expect(f.submissions).toEqual([]);
  } finally { f.gateway.disconnect(); }
});

function response(method: any, message: unknown, stream = false): any { return { stream, service: method.parent, method, header: new Headers(), trailer: new Headers(), message }; }
async function* idle(): AsyncIterable<never> { await new Promise<never>(() => undefined); }
