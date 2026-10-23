import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, type Transport } from "@connectrpc/connect";
import * as contract from "@joko/contracts";
import { expect, it, vi } from "vitest";
import { createOrchestratorGateway } from "./gateway.js";

function fixture() {
  const payloads: contract.OperationMutation["payload"][] = [];
  let generation = 23n, unknown = false, reject = false;
  const transport = { unary: vi.fn(async (method: any, _signal: unknown, _timeout: unknown, _headers: unknown, input: any) => {
    let value: unknown;
    if (method.localName === "getSnapshot") value = { snapshot: { generation: 1n, resumeCursor: { generation: 1n, sequence: 0n } } };
    else if (method.localName === "getSessionRuntimeControl") value = { control: { generation, handoffState: unknown ? "unknown" : "pending",
      effective: { backendId: "current", providerId: "account", modelId: "same-name", fastMode: false },
      pending: { backendId: "opaque-source", providerId: "account", modelId: "same-name", fastMode: true } } };
    else if (method.localName === "submitOperation") {
      payloads.push(input.mutation.payload);
      if (reject) throw new ConnectError("The model source generation changed", Code.Aborted);
      generation += 1n; value = { operation: { operationId: input.operationId, connectionId: input.connectionId, state: contract.OperationState.SUCCEEDED,
        result: { payload: { case: "acknowledgement", value: { accepted: true } } } } };
    } else throw new Error("Optional service unavailable");
    return { stream: false, method, service: method.parent, header: new Headers(), trailer: new Headers(), message: create(method.output, value as any) };
  }), stream: vi.fn() } as unknown as Transport;
  const gateway = createOrchestratorGateway({ id: "owner", serverId: "node", deviceId: "browser", name: "Node", origin: "https://node.invalid" }, "private-key", {}, () => transport);
  return { gateway, payloads, unknown: () => { unknown = true; }, reject: () => { reject = true; } };
}
it("reads the real runtime-control generation and submits a complete exact source configuration through the owner Gateway", async () => {
  const f = fixture(); await f.gateway.connect({ snapshotOnly: true });
  try {
    expect((await f.gateway.getSessionRuntimeControl!("task")).generation).toBe(23n);
    await f.gateway.setRuntimeModel!("task", { backendId: "opaque-source", providerId: "account", modelId: "same-name", effort: "high", fastMode: true });
    expect(f.payloads).toEqual([expect.objectContaining({ case: "setSessionRuntime", value: expect.objectContaining({ sessionId: "task",
      expectedRuntimeGeneration: 23n, backendId: "opaque-source", providerId: "account", modelId: "same-name", effort: "high", fastMode: true }) })]);
    f.reject(); await expect(f.gateway.setRuntimeModel!("task", { backendId: "another-source", providerId: "account", modelId: "same-name", fastMode: false })).rejects.toThrow();
    expect(f.payloads).toHaveLength(2);
  } finally { f.gateway.disconnect(); }
});
it("refuses to overwrite an unknown handoff before sending any mutation", async () => {
  const f = fixture(); await f.gateway.connect({ snapshotOnly: true });
  try {
    f.unknown(); await expect(f.gateway.setRuntimeModel!("task", { backendId: "opaque-source", providerId: "account", modelId: "same-name", fastMode: false })).rejects.toThrow("recovered");
    expect(f.payloads).toEqual([]);
  } finally { f.gateway.disconnect(); }
});
