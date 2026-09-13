import { create } from "@bufbuild/protobuf";
import type { Transport } from "@connectrpc/connect";
import {
  GetSnapshotResponseSchema,
  OperationState,
  SnapshotSchema,
  SubmitOperationResponseSchema
} from "@joko/contracts";
import { describe, expect, it, vi } from "vitest";
import { createOrchestratorGateway } from "./gateway.js";

describe("Backend-neutral user shell gateway", () => {
  it("submits only the generic user-shell mutations", async () => {
    const payloads: unknown[] = [];
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
            operation: {
              operationId: input.operationId,
              connectionId: input.connectionId,
              state: OperationState.SUCCEEDED
            }
          }));
        }
        throw new Error("Unexpected method: " + method.localName);
      }),
      stream: vi.fn(async (method: any) => response(method, idleStream(), true))
    } as unknown as Transport;
    const gateway = createOrchestratorGateway(
      { id: "connection-shell", deviceId: "device-test", name: "Browser", origin: "https://orchestrator.example" , serverId: "server-test" },
      "secret",
      {},
      () => transport
    );
    await gateway.connect();

    await gateway.executeUserShell("session-1", "  git status  ", true);
    await gateway.abortUserShell("session-1");

    expect(payloads).toMatchObject([
      { case: "executeUserShell", value: { sessionId: "session-1", command: "git status", excludeFromContext: true } },
      { case: "abortUserShell", value: { sessionId: "session-1" } }
    ]);
    gateway.disconnect();
  });
});

function response(method: any, message: unknown, stream = false): any {
  return { stream, service: method.parent, method, header: new Headers(), trailer: new Headers(), message };
}

async function* idleStream(): AsyncIterable<never> {
  await new Promise<never>(() => undefined);
}
