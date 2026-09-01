import { create } from "@bufbuild/protobuf";
import type { Transport } from "@connectrpc/connect";
import { GetSnapshotResponseSchema, OperationState, SnapshotSchema, SubmitOperationResponseSchema } from "@joko/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOrchestratorGateway } from "./gateway.js";

describe("structured message-reference gateway wiring", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("accepts a chip-only draft and emits its canonical link as a real text input part", async () => {
    vi.stubGlobal("window", { location: { href: "https://joko.test/app?profile=local#/tasks/current" } });
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
    const gateway = createOrchestratorGateway({ id: "connection-message", deviceId: "device-test", name: "Browser", origin: "https://orchestrator.example" , serverId: "server-test" }, "secret", {}, () => transport);
    await gateway.connect();

    await gateway.send("session-current", {
      text: "",
      attachments: [],
      mentions: [{
        id: "message:task-one:event-nine",
        kind: "message",
        reference: "entry:42",
        label: "Review task",
        sessionId: "task/one",
        role: "assistant",
        sourceEventId: "event/9"
      }],
      deliveryMode: "prompt"
    });

    expect(payloads[0]?.value.input.parts.map((part: any) => ({ content: part.content }))).toEqual([{
      content: {
        case: "text",
        value: "https://joko.test/app?profile=local#/tasks/task%2Fone?event=event%2F9&message=entry%3A42"
      }
    }]);
    gateway.disconnect();
  });
});

function response(method: any, message: unknown, stream = false): any {
  return { stream, service: method.parent, method, header: new Headers(), trailer: new Headers(), message };
}

async function* idleStream(): AsyncIterable<never> {
  await new Promise<never>(() => undefined);
}
