import { create } from "@bufbuild/protobuf";
import type { Transport } from "@connectrpc/connect";
import {
  GetSnapshotResponseSchema,
  ListRuntimeProcessesResponseSchema,
  OperationState,
  RuntimeProcessUsageSchema,
  SnapshotSchema,
  SubmitOperationResponseSchema
} from "@joko/contracts";
import { describe, expect, it, vi } from "vitest";
import { createOrchestratorGateway } from "./gateway.js";

const INSTANCE = "10000000-0000-4000-8000-000000000001";

describe("runtime process gateway", () => {
  it("maps bounded display metrics and submits every public spawn fence", async () => {
    const calls: Array<{ readonly method: string; readonly input: any }> = [];
    const transport = processTransport((method, input) => {
      calls.push({ method: method.localName, input });
      if (method.localName === "listRuntimeProcesses") {
        return create(ListRuntimeProcessesResponseSchema, {
          capturedAt: { seconds: 123n, nanos: 456_000_000 },
          processes: [create(RuntimeProcessUsageSchema, {
            backendId: "backend-local",
            sessionId: "session-one",
            runtimeGeneration: 7n,
            processId: 42n,
            cpuPercent: 12.5,
            memoryKb: 4096n,
            processCount: 3,
            terminable: true,
            processInstanceId: INSTANCE
          })]
        });
      }
      if (method.localName === "submitOperation") {
        return create(SubmitOperationResponseSchema, {
          operation: {
            operationId: input.operationId,
            connectionId: input.connectionId,
            state: OperationState.SUCCEEDED,
            result: { payload: { case: "acknowledgement", value: { accepted: true } } }
          }
        });
      }
      throw new Error(`Unexpected method ${method.localName}`);
    });
    const gateway = createOrchestratorGateway(
      { id: "connection-process", deviceId: "device-test", name: "Desktop", origin: "https://orchestrator.example" , serverId: "server-test" },
      "secret",
      {},
      () => transport
    );
    await gateway.connect();

    const abort = new AbortController();
    const snapshot = await gateway.listRuntimeProcesses("backend-local", abort.signal);
    expect(snapshot).toEqual({
      capturedAt: 123_456,
      processes: [{
        backendId: "backend-local",
        sessionId: "session-one",
        generation: 7,
        pid: 42,
        cpuPercent: 12.5,
        memoryKb: 4096,
        processCount: 3,
        terminable: true,
        processInstanceId: INSTANCE
      }]
    });
    await gateway.terminateRuntimeProcess(snapshot.processes[0]!);

    expect(calls.find((call) => call.method === "listRuntimeProcesses")?.input).toEqual({ backendId: "backend-local" });
    expect(calls.find((call) => call.method === "submitOperation")?.input.mutation.payload).toMatchObject({
      case: "terminateRuntimeProcess",
      value: {
        backendId: "backend-local",
        sessionId: "session-one",
        runtimeGeneration: 7n,
        processId: 42n,
        processInstanceId: INSTANCE
      }
    });
    gateway.disconnect();
  });

  it("rejects incomplete terminable rows and unsafe numeric identities", async () => {
    const transport = processTransport((method) => {
      if (method.localName !== "listRuntimeProcesses") throw new Error("Unexpected method");
      return create(ListRuntimeProcessesResponseSchema, {
        capturedAt: { seconds: 1n, nanos: 0 },
        processes: [{
          backendId: "backend-local",
          sessionId: "session-one",
          runtimeGeneration: 1n,
          processId: BigInt(Number.MAX_SAFE_INTEGER) + 1n,
          cpuPercent: 0,
          memoryKb: 0n,
          processCount: 1,
          terminable: true
        }]
      });
    });
    const gateway = createOrchestratorGateway(
      { id: "connection-process", deviceId: "device-test", name: "Desktop", origin: "https://orchestrator.example" , serverId: "server-test" },
      "secret",
      {},
      () => transport
    );
    await gateway.connect();

    await expect(gateway.listRuntimeProcesses("backend-local")).rejects.toThrow("invalid runtime-process fence or metric");
    await expect(gateway.terminateRuntimeProcess({
      backendId: "backend-local",
      sessionId: "session-one",
      generation: 1,
      pid: 42,
      cpuPercent: 0,
      memoryKb: 0,
      processCount: 1,
      terminable: true
    })).rejects.toThrow("current terminable runtime-process fence");
    gateway.disconnect();
  });
});

function processTransport(resolve: (method: any, input: any) => unknown): Transport {
  return {
    unary: vi.fn(async (method: any, _signal: unknown, _timeout: unknown, _headers: unknown, input: any) => {
      const message = method.localName === "getSnapshot"
        ? create(GetSnapshotResponseSchema, {
          snapshot: create(SnapshotSchema, {
            generation: 1n,
            resumeCursor: { generation: 1n, sequence: 0n }
          })
        })
        : resolve(method, input);
      return response(method, message);
    }),
    stream: vi.fn(async (method: any) => response(method, idleStream(), true))
  } as unknown as Transport;
}

function response(method: any, message: unknown, stream = false): any {
  return {
    stream,
    service: method.parent,
    method,
    header: new Headers(),
    trailer: new Headers(),
    message
  };
}

async function* idleStream(): AsyncIterable<never> {
  await new Promise<never>(() => undefined);
}
