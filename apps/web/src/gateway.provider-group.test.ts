import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, type Transport } from "@connectrpc/connect";
import { OperationState, ProviderGroupKeySchema, SessionState } from "@joko/contracts";
import { expect, it, vi } from "vitest";
import { createOrchestratorGateway } from "./gateway.js";

const key = `rebalance_${"a".repeat(64)}`;
async function fixture(read?: () => Promise<unknown>, loseFirstSubmit = false) {
  const session = { sessionId: "original-task", backendId: "native", targetId: "project", state: SessionState.IDLE,
    location: { kind: { case: "serviceNode" as const, value: {} } },
    nativeBinding: { opaqueReference: "private-native-task", runtimeGeneration: 3n }, model: { model: { backendId: "native", providerId: "account", modelId: "model" }, effortId: "high", fastMode: false } };
  const suggestion = { suggestionKey: key, generation: 3n, group: { backendId: "native", providerId: "account" }, fromMemberKey: "from", toMemberKey: "to",
    fromLabel: "Current computer", toLabel: "Other computer", automatic: false,
    currentQuota: { limited: false, urgency: 0.2, pacingWindow: { usedPercent: 80, windowMs: 604_800_000, resetAt: Date.now() + 604_800_000 } },
    targetQuota: { limited: false, urgency: 0.8, pacingWindow: { usedPercent: 20, windowMs: 604_800_000, resetAt: Date.now() + 604_800_000 } } };
  const calls: Array<{ method: string; input: any }> = [];
  let submissions = 0;
  const transport = { unary: vi.fn(async (method: any, _signal: unknown, _timeout: unknown, _headers: unknown, input: any) => {
    calls.push({ method: method.localName, input });
    let value: unknown;
    if (method.localName === "getSnapshot") value = { snapshot: { generation: 1n, sessions: [session] } };
    else if (method.localName === "getTaskProviderGroupRebalance") value = read ? await read() : { suggestion };
    else if (method.localName === "getProviderGroupMemberAccountUsage") value = read ? await read() : { memberKey: "from", revision: 5n, state: "unsupported" };
    else if (method.localName === "submitOperation") {
      if (++submissions === 1 && loseFirstSubmit) throw new ConnectError("Original admission response was lost", Code.Unavailable);
      value = { operation: { operationId: input.operationId, connectionId: input.connectionId, state: OperationState.SUCCEEDED, mutation: input.mutation } };
    } else throw new Error(`Unexpected method ${method.localName}`);
    return { stream: false, service: method.parent, method, header: new Headers(), trailer: new Headers(), message: create(method.output, value as any) };
  }), stream: vi.fn() } as unknown as Transport;
  const gateway = createOrchestratorGateway({ id: "connection", deviceId: "device", serverId: "original-node", name: "Original node", origin: "https://group.example" }, "original-key", {}, () => transport);
  await gateway.connect({ snapshotOnly: true });
  return { gateway, calls, session, suggestion };
}

it("reads the exact native generation and carries only its fixed choice on the original generated send mutation", async () => {
  const f = await fixture();
  try {
    const proposal = await f.gateway.readTaskProviderGroupRebalance!("original-task", 3n);
    expect(proposal).toEqual({ suggestionKey: key, generation: 3n, fromLabel: "Current computer", toLabel: "Other computer", automatic: false });
    await f.gateway.send("original-task", { text: "Original draft", attachments: [], mentions: [], deliveryMode: "prompt" },
      { expectedGeneration: 3n, providerGroupRebalance: { suggestionKey: proposal!.suggestionKey, remember: true } });
    expect(f.calls.filter(call => call.method === "getTaskProviderGroupRebalance")).toMatchObject([{ input: { sessionId: "original-task", generation: 3n } }]);
    const sends = f.calls.filter(call => call.method === "submitOperation");
    expect(sends).toHaveLength(1); expect(sends[0]!.input.mutation).toMatchObject({ preconditions: [{ entity: { id: "original-task" }, expectedGeneration: 3n }],
      payload: { case: "sendInput", value: { sessionId: "original-task", providerGroupRebalance: { suggestionKey: key, remember: true } } } });
    expect(sends[0]!.input.mutation.payload.value.input).not.toHaveProperty("providerGroupRebalance");
  } finally { f.gateway.disconnect(); }
});

it("forwards expanded account quota through the authenticated group facade and retires its connection", async () => {
  let finish!: (value: unknown) => void;
  const f = await fixture(() => new Promise(resolve => { finish = resolve; }));
  try {
    const api = f.gateway.providerGroupSettingsApi();
    const query = { key: create(ProviderGroupKeySchema, { backendId: "native", providerId: "account" }), memberKey: "from", expectedRevision: 5n };
    const pending = api.getProviderGroupMemberAccountUsage(query), rejected = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    expect(f.calls.filter(call => call.method === "getProviderGroupMemberAccountUsage")).toMatchObject([{ input: query }]);
    f.gateway.disconnect();
    finish({ memberKey: "from", revision: 5n, state: "unsupported" });
    await rejected;
  } finally { f.gateway.disconnect(); }
});

it.each(["generation", "disconnect"])("discards delayed suggestions after original %s retirement", async kind => {
  let release!: (value: unknown) => void;
  const f = await fixture(() => new Promise(resolve => { release = resolve; }));
  try {
    const pending = f.gateway.readTaskProviderGroupRebalance!("original-task", 3n), rejected = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    if (kind === "generation") { f.session.nativeBinding.runtimeGeneration = 4n; await f.gateway.refresh(); }
    else f.gateway.disconnect();
    release({ suggestion: f.suggestion }); await rejected;
    expect(f.calls.filter(call => call.method === "submitOperation")).toEqual([]);
  } finally { f.gateway.disconnect(); }
});

it("keeps the same Operation and proposal when an ordinary send admission receipt is lost", async () => {
  const f = await fixture(undefined, true);
  try {
    await f.gateway.readTaskProviderGroupRebalance!("original-task", 3n);
    await f.gateway.send("original-task", { text: "Send only once", attachments: [], mentions: [], deliveryMode: "prompt" },
      { expectedGeneration: 3n, providerGroupRebalance: { suggestionKey: key, remember: false } });
    const attempts = f.calls.filter(call => call.method === "submitOperation");
    expect(attempts).toHaveLength(2); expect(attempts[1]!.input).toEqual(attempts[0]!.input);
    expect(f.calls.filter(call => call.method === "getTaskProviderGroupRebalance")).toHaveLength(1);
  } finally { f.gateway.disconnect(); }
});
