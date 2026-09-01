import { create } from "@bufbuild/protobuf";
import type { Transport } from "@connectrpc/connect";
import {
  GetSnapshotResponseSchema,
  OperationState,
  SnapshotSchema,
  SubmitOperationResponseSchema,
  WatchOperationResponseSchema
} from "@joko/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppSnapshot } from "./model.js";

import { createOrchestratorGateway } from "./gateway.js";

describe("message deletion gateway", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("submits the stable Event identity, waits for commit, and refreshes authoritatively", async () => {
    vi.stubGlobal("window", { location: { href: "https://joko.test/#/tasks/current" } });
    const payloads: unknown[] = [];
    const snapshots: AppSnapshot[] = [];
    let snapshotReads = 0;
    const transport = {
      unary: vi.fn(async (method: any, _signal: unknown, _timeout: unknown, _headers: unknown, input: any) => {
        if (method.localName === "getSnapshot") {
          snapshotReads += 1;
          return response(method, create(GetSnapshotResponseSchema, {
            snapshot: create(SnapshotSchema, { generation: 1n, resumeCursor: { generation: 1n, sequence: BigInt(snapshotReads) } })
          }));
        }
        if (method.localName === "submitOperation") {
          payloads.push(input.mutation?.payload);
          return response(method, create(SubmitOperationResponseSchema, {
            operation: { operationId: input.operationId, connectionId: input.connectionId, state: OperationState.RUNNING }
          }));
        }
        throw new Error(`Unexpected method: ${method.localName}`);
      }),
      stream: vi.fn(async (method: any, _signal: unknown, _timeout: unknown, _headers: unknown, input: any) => response(
        method,
        method.localName === "watchOperation" ? terminalStream(input.operationId) : idleStream(),
        true
      ))
    } as unknown as Transport;
    const gateway = createOrchestratorGateway(
      { id: "connection-delete", deviceId: "device-test", name: "Browser", origin: "https://orchestrator.example" , serverId: "server-test" },
      "secret",
      { onSnapshot: (snapshot) => snapshots.push(snapshot) },
      () => transport
    );
    await gateway.connect();

    await gateway.deleteSessionMessage("session-one", "event-assistant-complete");

    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toMatchObject({
      case: "deleteSessionMessage",
      value: { sessionId: "session-one", eventId: "event-assistant-complete" }
    });
    expect(snapshotReads).toBeGreaterThanOrEqual(2);
    expect(snapshots.at(-1)?.timelineHistoryRevisionBySession.get("session-one")).toBeGreaterThan(0n);
    gateway.disconnect();
  });
});

function response(method: any, message: unknown, stream = false): any {
  return { stream, service: method.parent, method, header: new Headers(), trailer: new Headers(), message };
}

async function* terminalStream(operationId: string) {
  yield create(WatchOperationResponseSchema, {
    operation: {
      operationId,
      state: OperationState.SUCCEEDED,
      result: { payload: { case: "acknowledgement", value: { accepted: true } } }
    }
  });
}

async function* idleStream(): AsyncIterable<never> {
  await new Promise<never>(() => undefined);
}
