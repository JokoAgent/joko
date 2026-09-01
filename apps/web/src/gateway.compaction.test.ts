import { create } from "@bufbuild/protobuf";
import type { Transport } from "@connectrpc/connect";
import {
  CompactSessionOutcome,
  GetOperationResponseSchema,
  GetSnapshotResponseSchema,
  OperationState,
  SnapshotSchema,
  SubmitOperationResponseSchema,
  WatchOperationResponseSchema
} from "@joko/contracts";
import { describe, expect, it, vi } from "vitest";
import { createOrchestratorGateway } from "./gateway.js";

describe("typed compact Session result", () => {
  it.each([
    [CompactSessionOutcome.COMPACTED, "compacted"],
    [CompactSessionOutcome.NOOP, "noop"]
  ] as const)("maps outcome %s to %s", async (outcome, expected) => {
    const payloads: unknown[] = [];
    const transport = compactTransport({ outcome, payloads });
    const gateway = createOrchestratorGateway(
      { id: "connection-compact", deviceId: "device-test", name: "Browser", origin: "https://orchestrator.example" , serverId: "server-test" },
      "secret",
      {},
      () => transport
    );
    await gateway.connect();

    await expect(gateway.compact("session-1")).resolves.toBe(expected);
    expect(payloads).toMatchObject([{
      case: "compactSession",
      value: { sessionId: "session-1", customInstructions: "" }
    }]);
    gateway.disconnect();
  });

  it("fails closed when Orchestrator omits the typed outcome", async () => {
    const gateway = createOrchestratorGateway(
      { id: "connection-compact", deviceId: "device-test", name: "Browser", origin: "https://orchestrator.example" , serverId: "server-test" },
      "secret",
      {},
      () => compactTransport({ outcome: CompactSessionOutcome.UNSPECIFIED, payloads: [] })
    );
    await gateway.connect();
    await expect(gateway.compact("session-1")).rejects.toThrow("unknown compact Session outcome");
    gateway.disconnect();
  });

  it("passes trimmed optional summary instructions through the typed operation", async () => {
    const payloads: unknown[] = [];
    const gateway = createOrchestratorGateway(
      { id: "connection-compact", deviceId: "device-test", name: "Browser", origin: "https://orchestrator.example" , serverId: "server-test" },
      "secret",
      {},
      () => compactTransport({ outcome: CompactSessionOutcome.COMPACTED, payloads })
    );
    await gateway.connect();

    await expect(gateway.compact("session-1", "  preserve decisions and API names  ")).resolves.toBe("compacted");
    expect(payloads).toMatchObject([{
      case: "compactSession",
      value: { sessionId: "session-1", customInstructions: "preserve decisions and API names" }
    }]);
    gateway.disconnect();
  });

  it.each(["acknowledgement", "missing"] as const)("fails closed when Orchestrator returns a %s compact result", async (resultKind) => {
    const gateway = createOrchestratorGateway(
      { id: "connection-compact", deviceId: "device-test", name: "Browser", origin: "https://orchestrator.example" , serverId: "server-test" },
      "secret",
      {},
      () => compactTransport({
        outcome: CompactSessionOutcome.COMPACTED,
        payloads: [],
        resultKind
      })
    );
    await gateway.connect();
    await expect(gateway.compact("session-1")).rejects.toThrow("without a typed outcome");
    gateway.disconnect();
  });

  it("waits for the terminal typed compact result", async () => {
    const gateway = createOrchestratorGateway(
      { id: "connection-compact", deviceId: "device-test", name: "Browser", origin: "https://orchestrator.example" , serverId: "server-test" },
      "secret",
      {},
      () => compactTransport({
        outcome: CompactSessionOutcome.NOOP,
        payloads: [],
        submitState: OperationState.RUNNING,
        watchTerminal: true
      })
    );
    await gateway.connect();
    await expect(gateway.compact("session-1")).resolves.toBe("noop");
    gateway.disconnect();
  });

  it("reconciles with GetOperation when WatchOperation closes before yielding terminal state", async () => {
    const gateway = createOrchestratorGateway(
      { id: "connection-compact", deviceId: "device-test", name: "Browser", origin: "https://orchestrator.example" , serverId: "server-test" },
      "secret",
      {},
      () => compactTransport({
        outcome: CompactSessionOutcome.COMPACTED,
        payloads: [],
        submitState: OperationState.RUNNING,
        reconciledState: OperationState.SUCCEEDED
      })
    );
    await gateway.connect();
    await expect(gateway.compact("session-1")).resolves.toBe("compacted");
    gateway.disconnect();
  });

  it("does not parse a non-terminal result after WatchOperation closes", async () => {
    const gateway = createOrchestratorGateway(
      { id: "connection-compact", deviceId: "device-test", name: "Browser", origin: "https://orchestrator.example" , serverId: "server-test" },
      "secret",
      {},
      () => compactTransport({
        outcome: CompactSessionOutcome.COMPACTED,
        payloads: [],
        submitState: OperationState.RUNNING,
        reconciledState: OperationState.RUNNING
      })
    );
    await gateway.connect();
    await expect(gateway.compact("session-1")).rejects.toThrow("before it reached a terminal state");
    gateway.disconnect();
  });
});

interface CompactTransportOptions {
  readonly outcome: CompactSessionOutcome;
  readonly payloads: unknown[];
  readonly resultKind?: "typed" | "acknowledgement" | "missing";
  readonly submitState?: OperationState;
  readonly watchTerminal?: boolean;
  readonly reconciledState?: OperationState;
}

function compactTransport(options: CompactTransportOptions): Transport {
  const resultKind = options.resultKind ?? "typed";
  const submitState = options.submitState ?? OperationState.SUCCEEDED;
  return {
    unary: vi.fn(async (method: any, _signal: unknown, _timeout: unknown, _headers: unknown, input: any) => {
      if (method.localName === "getSnapshot") {
        return response(method, create(GetSnapshotResponseSchema, {
          snapshot: create(SnapshotSchema, {
            generation: 1n,
            resumeCursor: { generation: 1n, sequence: 0n }
          })
        }));
      }
      if (method.localName === "submitOperation") {
        options.payloads.push(input.mutation?.payload);
        return response(method, create(SubmitOperationResponseSchema, {
          operation: {
            operationId: input.operationId,
            connectionId: input.connectionId,
            state: submitState,
            ...(submitState === OperationState.RUNNING ? {} : { result: compactResult(resultKind, options.outcome) })
          }
        }));
      }
      if (method.localName === "getOperation") {
        const state = options.reconciledState ?? OperationState.RUNNING;
        return response(method, create(GetOperationResponseSchema, {
          operation: {
            operationId: input.operationId,
            state,
            ...(state === OperationState.RUNNING ? {} : { result: compactResult(resultKind, options.outcome) })
          }
        }));
      }
      throw new Error(`Unexpected method: ${method.localName}`);
    }),
    stream: vi.fn(async (method: any, _signal: unknown, _timeout: unknown, _headers: unknown, input: any) => response(
      method,
      method.localName === "watchOperation"
        ? options.watchTerminal === true
          ? terminalStream(input.operationId, resultKind, options.outcome)
          : emptyStream()
        : idleStream(),
      true
    ))
  } as unknown as Transport;
}

function compactResult(kind: "typed" | "acknowledgement" | "missing", outcome: CompactSessionOutcome) {
  if (kind === "missing") return undefined;
  return kind === "acknowledgement"
    ? { payload: { case: "acknowledgement" as const, value: { accepted: true } } }
    : { payload: { case: "compactSession" as const, value: { outcome } } };
}

function response(method: any, message: unknown, stream = false): any {
  return { stream, service: method.parent, method, header: new Headers(), trailer: new Headers(), message };
}

async function* terminalStream(operationId: string, resultKind: "typed" | "acknowledgement" | "missing", outcome: CompactSessionOutcome) {
  yield create(WatchOperationResponseSchema, {
    operation: {
      operationId,
      state: OperationState.SUCCEEDED,
      result: compactResult(resultKind, outcome)
    }
  });
}

async function* emptyStream(): AsyncIterable<never> {
  return;
}

async function* idleStream(): AsyncIterable<never> {
  await new Promise<never>(() => undefined);
}
