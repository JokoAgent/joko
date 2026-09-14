import { create } from "@bufbuild/protobuf";
import type { Transport } from "@connectrpc/connect";
import {
  BackendMemoryKind,
  CapabilitySupport,
  GetSnapshotResponseSchema,
  MemoryResetScope,
  OperationState,
  SnapshotSchema,
  SubmitOperationResponseSchema
} from "@joko/contracts";
import { describe, expect, it, vi } from "vitest";

import { createOrchestratorGateway, mapSnapshot } from "./gateway.js";

describe("OrchestratorGateway Memory reset scopes", () => {
  it("preserves the typed Backend memory role and reset authority", () => {
    const projected = mapSnapshot(create(SnapshotSchema, {
      settings: {
        auxiliaryText: { revision: { value: 0n }, runtimeRevision: "fixture:0" },
        agentResource: {},
        collaboration: {},
        gitSafety: {},
        memory: {
          makerEnabled: false,
          makerSupport: CapabilitySupport.SUPPORTED,
          backends: [{
            backendId: "claude-code",
            enabled: true,
            support: CapabilitySupport.SUPPORTED,
            kind: BackendMemoryKind.NATIVE_AUTO_MEMORY,
            resettable: false
          }]
        }
      }
    }));

    expect(projected.settings.memory.backends).toEqual([{
      backendId: "claude-code",
      enabled: true,
      supported: true,
      reason: "",
      entryCount: 0,
      kind: "native_auto_memory",
      resettable: false
    }]);
  });

  it("sends distinct CURATED and capability-owned BACKEND mutations", async () => {
    const mutations: any[] = [];
    const gateway = createOrchestratorGateway(
      { id: "connection-1", deviceId: "device-test", name: "Desktop", origin: "https://orchestrator.example" , serverId: "server-test" },
      "secret",
      {},
      () => transport((method, input) => {
        mutations.push(input.mutation.payload.value);
        return response(method, create(SubmitOperationResponseSchema, {
          operation: {
            operationId: input.operationId,
            connectionId: input.connectionId,
            state: OperationState.SUCCEEDED,
            result: {
              payload: {
                case: "memoryReset",
                value: { removedEntries: 2n, removedTargets: 1n }
              }
            }
          }
        }));
      })
    );
    await gateway.connect();

    await expect(gateway.resetMemory("curated")).resolves.toEqual({ removedEntries: 2, removedTargets: 1 });
    await expect(gateway.resetMemory("backend", "memory-capable")).resolves.toEqual({ removedEntries: 2, removedTargets: 1 });
    expect(mutations).toMatchObject([
      { scope: MemoryResetScope.CURATED, backendId: "" },
      { scope: MemoryResetScope.BACKEND, backendId: "memory-capable" }
    ]);
    gateway.disconnect();
  });
});

function transport(submit: (method: any, input: any) => any): Transport {
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
      if (method.localName === "submitOperation") return submit(method, input);
      throw new Error(`Unexpected method: ${method.localName}`);
    }),
    stream: vi.fn(async (method: any) => response(method, idleStream(), true))
  } as unknown as Transport;
}

function response(method: any, message: unknown, stream = false): any {
  return { stream, service: method.parent, method, header: new Headers(), trailer: new Headers(), message };
}

async function* idleStream(): AsyncIterable<never> {
  await new Promise<never>(() => undefined);
}
