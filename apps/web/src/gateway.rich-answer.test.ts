import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, type Transport } from "@connectrpc/connect";
import {
  CapabilitySupport, EntityKind, GetOperationResponseSchema, GetSnapshotResponseSchema,
  ListManagedModelRuntimesResponseSchema, OperationSchema, OperationState, QueueDeliveryMode,
  SessionState, SnapshotSchema, SubmitOperationResponseSchema, type Operation
} from "@joko/contracts";
import { expect, it, vi } from "vitest";
import { createOrchestratorGateway } from "./gateway.js";

function fixture() {
  const receipts = new Map<string, Operation>();
  const mutations: any[] = [];
  let generation = 8n, loseReply = false;
  let beforeRead = async () => {};
  const transport = {
    unary: vi.fn(async (method: any, _signal: unknown, _timeout: unknown, _headers: unknown, input: any) => {
      const response = (message: unknown) => ({ stream: false, service: method.parent, method, header: new Headers(), trailer: new Headers(), message });
      if (method.localName === "getSnapshot") return response(create(GetSnapshotResponseSchema, { snapshot: create(SnapshotSchema, {
        generation: 1n, resumeCursor: { generation: 1n, sequence: 0n },
        backends: [{ backendId: "backend", capabilities: { capabilities: [{ name: "input.text", support: CapabilitySupport.SUPPORTED }] } }],
        sessions: [{ sessionId: "task", backendId: "backend", targetId: "target", state: SessionState.IDLE,
          location: { kind: { case: "serviceNode", value: {} } }, nativeBinding: { runtimeGeneration: generation } }]
      }) }));
      if (method.localName === "listManagedModelRuntimes") return response(create(ListManagedModelRuntimesResponseSchema));
      if (method.localName === "getOperation") {
        await beforeRead();
        const operation = receipts.get(input.operationId);
        if (!operation) throw new ConnectError("not found", Code.NotFound);
        return response(create(GetOperationResponseSchema, { operation }));
      }
      if (method.localName === "submitOperation") {
        mutations.push(input);
        const operation = create(OperationSchema, { operationId: input.operationId, connectionId: input.connectionId, state: OperationState.SUCCEEDED });
        receipts.set(input.operationId, operation);
        if (loseReply) throw new ConnectError("response lost", Code.Unavailable);
        return response(create(SubmitOperationResponseSchema, { operation }));
      }
      throw new Error(`Unexpected method: ${method.localName}`);
    }),
    stream: vi.fn(async (method: any) => ({ stream: true, service: method.parent, method, header: new Headers(), trailer: new Headers(),
      message: (async function* () { await new Promise(() => {}); })() }))
  } as unknown as Transport;
  const open = () => createOrchestratorGateway({ id: "connection", deviceId: "device", name: "Web", origin: "https://node.example", serverId: "server" }, "key", {}, () => transport);
  return { open, receipts, mutations, setGeneration: (value: bigint) => { generation = value; },
    loseReply: () => { loseReply = true; }, beforeRead: (read: () => Promise<void>) => { beforeRead = read; } };
}

it("sends literal text without composer intent and recovers the original operation after response or view-state loss", async () => {
  const f = fixture(), gateway = f.open();
  await gateway.connect(); f.loseReply();
  try {
    expect(await gateway.sendRichAnswer("task", 8n, "answer:button", "/review explicit text")).toBe(true);
    expect(f.mutations).toHaveLength(1);
    expect(f.mutations[0].mutation).toMatchObject({
      preconditions: [{ entity: { kind: EntityKind.SESSION, id: "task" }, expectedGeneration: 8n }],
      payload: { case: "sendInput", value: { sessionId: "task", deliveryMode: QueueDeliveryMode.PROMPT,
        input: { parts: [{ content: { case: "text", value: "/review explicit text" } }] } } }
    });
    const restored = f.open();
    await restored.connect();
    try { expect(await restored.sendRichAnswer("task", 8n, "answer:button", "/review explicit text")).toBe(true); }
    finally { restored.disconnect(); }
    expect(f.mutations).toHaveLength(1);
  } finally { gateway.disconnect(); }
});

it("creates a different attempt only after a confirmed rejection and blocks stale task generations", async () => {
  const f = fixture(), gateway = f.open(); await gateway.connect();
  try {
    await gateway.sendRichAnswer("task", 8n, "answer:button", "Continue");
    const original = f.mutations[0].operationId;
    f.receipts.set(original, create(OperationSchema, { operationId: original, connectionId: "connection", state: OperationState.FAILED }));
    await gateway.sendRichAnswer("task", 8n, "answer:button", "Continue");
    expect(f.mutations).toHaveLength(2);
    expect(f.mutations[1].operationId).not.toBe(original);
    // submit() starts a background refresh. Settle that observation before
    // changing the server, so the next refresh cannot join the older request.
    await gateway.refresh();
    f.setGeneration(9n);
    await gateway.refresh();
    expect(await gateway.sendRichAnswer("task", 9n, "answer:button", "Continue")).toBe(true);
    await expect(gateway.sendRichAnswer("task", 8n, "answer:new", "Continue")).rejects.toThrow(/no longer current/);
    expect(f.mutations).toHaveLength(2);
  } finally { gateway.disconnect(); }
});

it("does not dispatch when the source pane retires during the receipt lookup", async () => {
  const f = fixture(), gateway = f.open(); await gateway.connect();
  const abort = new AbortController();
  f.beforeRead(async () => { abort.abort(); });
  try {
    await expect(gateway.sendRichAnswer("task", 8n, "answer:button", "Continue", abort.signal)).rejects.toThrow();
    expect(f.mutations).toHaveLength(0);
  } finally { gateway.disconnect(); }
});
