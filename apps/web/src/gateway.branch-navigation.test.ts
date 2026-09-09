import { create } from "@bufbuild/protobuf";
import type { Transport } from "@connectrpc/connect";
import {
  GetSnapshotResponseSchema,
  OperationState,
  SnapshotSchema,
  SubmitOperationResponseSchema
} from "@joko/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOrchestratorGateway } from "./gateway.js";

describe("Pi branch navigation gateway", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends bounded summary options and bounds the optional focus", async () => {
    vi.stubGlobal("window", { location: { href: "https://joko.test/#/tasks/current" } });
    const payloads: any[] = [];
    const preconditions: any[] = [];
    const transport = {
      unary: vi.fn(async (method: any, _signal: unknown, _timeout: unknown, _headers: unknown, input: any) => {
        if (method.localName === "getSnapshot") {
          return response(method, create(GetSnapshotResponseSchema, {
            snapshot: create(SnapshotSchema, { generation: 1n, resumeCursor: { generation: 1n, sequence: 0n } })
          }));
        }
        if (method.localName === "submitOperation") {
          payloads.push(input.mutation?.payload);
          preconditions.push(input.mutation?.preconditions);
          return response(method, create(SubmitOperationResponseSchema, {
            operation: { operationId: input.operationId, connectionId: input.connectionId, state: OperationState.SUCCEEDED }
          }));
        }
        throw new Error(`Unexpected method: ${method.localName}`);
      }),
      stream: vi.fn(async (method: any) => response(method, idleStream(), true))
    } as unknown as Transport;
    const gateway = createOrchestratorGateway(
      { id: "connection-branch", deviceId: "device-test", name: "Browser", origin: "https://orchestrator.example" , serverId: "server-test" },
      "secret",
      {},
      () => transport
    );
    await gateway.connect();

    await gateway.navigateSessionBranch("session-one", { kind: "native_entry", entryId: "entry-two" }, {
      expectedGeneration: 1n,
      summarize: true,
      customInstructions: `  ${"x".repeat(4_100)}  `
    });
    await gateway.navigateSessionBranch("session-one", { kind: "native_entry", entryId: "entry-three" }, {
      expectedGeneration: 1n,
      summarize: false,
      customInstructions: "must not leak into an unsummarized navigation"
    });

    expect(payloads[0]).toMatchObject({
      case: "navigateSessionBranch",
      value: {
        sessionId: "session-one",
        target: { kind: { case: "nativeEntryId", value: "entry-two" } },
        summarize: true,
        customInstructions: "x".repeat(4_000)
      }
    });
    expect(payloads[1]).toMatchObject({
      case: "navigateSessionBranch",
      value: {
        sessionId: "session-one",
        target: { kind: { case: "nativeEntryId", value: "entry-three" } },
        summarize: false,
        customInstructions: ""
      }
    });
    await gateway.navigateSessionBranch("session-one", { kind: "session_start" }, { expectedGeneration: 7n });
    expect(payloads[2]).toMatchObject({ case: "navigateSessionBranch", value: { sessionId: "session-one", target: { kind: { case: "sessionStart", value: {} } } } });
    expect(preconditions[2]).toMatchObject([{ entity: { id: "session-one" }, expectedGeneration: 7n }]);
    await expect(gateway.navigateSessionBranch("session-one", { kind: "session_start" }, { expectedGeneration: 0n })).rejects.toThrow(/generation/u);
    expect(payloads).toHaveLength(3);
    gateway.disconnect();
  });
});

function response(method: any, message: unknown, stream = false): any {
  return { stream, service: method.parent, method, header: new Headers(), trailer: new Headers(), message };
}

async function* idleStream(): AsyncIterable<never> {
  await new Promise<never>(() => undefined);
}
