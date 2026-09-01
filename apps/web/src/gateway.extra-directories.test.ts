import { create } from "@bufbuild/protobuf";
import type { Transport } from "@connectrpc/connect";
import { GetSnapshotResponseSchema, OperationState, SnapshotSchema, SubmitOperationResponseSchema } from "@joko/contracts";
import { describe, expect, it, vi } from "vitest";
import { createOrchestratorGateway } from "./gateway.js";

describe("per-turn extra-directory gateway selection", () => {
  it("distinguishes an explicit empty grant from the Session default", async () => {
    const payloads: any[] = [];
    const transport = {
      unary: vi.fn(async (method: any, _signal: unknown, _timeout: unknown, _headers: unknown, input: any) => {
        if (method.localName === "getSnapshot") {
          return response(method, create(GetSnapshotResponseSchema, {
            snapshot: create(SnapshotSchema, { generation: 1n, resumeCursor: { generation: 1n, sequence: 0n } })
          }));
        }
        if (method.localName === "submitOperation") {
          payloads.push(input.mutation?.payload);
          return response(method, create(SubmitOperationResponseSchema, {
            operation: { operationId: input.operationId, connectionId: input.connectionId, state: OperationState.SUCCEEDED }
          }));
        }
        throw new Error(`Unexpected method: ${method.localName}`);
      }),
      stream: vi.fn(async (method: any) => response(method, idleStream(), true))
    } as unknown as Transport;
    const gateway = createOrchestratorGateway({ id: "connection-extra", deviceId: "device-test", name: "Browser", origin: "https://orchestrator.example" , serverId: "server-test" }, "secret", {}, () => transport);
    await gateway.connect();

    await gateway.send("session-1", { text: "default directories", attachments: [], mentions: [], deliveryMode: "prompt" });
    await gateway.send("session-1", { text: "none", attachments: [], mentions: [], deliveryMode: "prompt", extraDirectoryIds: [] });
    await gateway.send("session-1", { text: "selected", attachments: [], mentions: [], deliveryMode: "prompt", extraDirectoryIds: ["extra-1", "extra-1", "extra-2"] });

    expect(payloads[0]?.value.overrides).toBeUndefined();
    expect(payloads[1]?.value.overrides?.extraDirectoryIds).toEqual([]);
    expect(payloads[2]?.value.overrides?.extraDirectoryIds).toEqual(["extra-1", "extra-2"]);
    gateway.disconnect();
  });
});

function response(method: any, message: unknown, stream = false): any {
  return { stream, service: method.parent, method, header: new Headers(), trailer: new Headers(), message };
}

async function* idleStream(): AsyncIterable<never> {
  await new Promise<never>(() => undefined);
}
