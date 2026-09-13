import { create } from "@bufbuild/protobuf";
import * as contract from "@joko/contracts";
import type { BackendAdapter, BackendDescriptor } from "@joko/core";
import { operationBodyHash, type OperationRecord, type OperationalStore } from "@joko/store";
import { describe, expect, it, vi } from "vitest";
import type { OrchestratorApplication } from "./application.js";
import { createConnectServices } from "./connect-services.js";

const PROCESS_INSTANCE = "10000000-0000-4000-8000-000000000001";
const connection = {
  id: "connection-process",
  name: "Process tests",
  authKeyDigest: "digest",
  state: "active" as const,
  pairedAt: 1,
  revision: 1n
};

describe("Connect runtime process surface", () => {
  it("maps only display-safe metrics from the generic Backend capability", async () => {
    const getRuntimeProcessUsage = vi.fn(async () => ({
      capturedAt: 2_000,
      processes: [{
        sessionId: "session-1",
        generation: 4,
        pid: 42,
        cpuPercent: 7.5,
        memoryKb: 4_096,
        processCount: 2,
        terminable: true,
        processInstanceId: PROCESS_INSTANCE
      }]
    }));
    const app = application(adapter({
      getRuntimeProcessUsage,
      terminateRuntimeProcess: async () => undefined
    }), 4);
    const response = await callBackendList(app);

    expect(getRuntimeProcessUsage).toHaveBeenCalledOnce();
    expect(response.processes).toEqual([expect.objectContaining({
      backendId: "backend-1",
      sessionId: "session-1",
      runtimeGeneration: 4n,
      processId: 42n,
      cpuPercent: 7.5,
      memoryKb: 4096n,
      processCount: 2,
      terminable: true,
      processInstanceId: PROCESS_INSTANCE
    })]);
    expect(Object.keys(response.processes[0] ?? {}).join(" ")).not.toMatch(/command|executable|environment|credential/iu);
  });

  it("persists the Operation claim before dispatching the complete termination fence", async () => {
    const order: string[] = [];
    const terminateRuntimeProcess = vi.fn(async () => { order.push("adapter"); });
    const app = application(adapter({ terminateRuntimeProcess }), 4, order);
    const services = createConnectServices(app);
    const mutation = create(contract.OperationMutationSchema, {
      payload: {
        case: "terminateRuntimeProcess",
        value: {
          backendId: "backend-1",
          sessionId: "session-1",
          runtimeGeneration: 4n,
          processId: 42n,
          processInstanceId: PROCESS_INSTANCE
        }
      }
    });
    const response = await (services.operation.submitOperation as (
      request: unknown,
      handlerContext: unknown
    ) => Promise<contract.SubmitOperationResponse>)({
      operationId: "operation-terminate-runtime",
      connectionId: connection.id,
      mutation
    }, context());

    expect(order).toEqual(["persist", "adapter", "complete"]);
    expect(terminateRuntimeProcess).toHaveBeenCalledWith({
      sessionId: "session-1",
      generation: 4,
      pid: 42,
      processInstanceId: PROCESS_INSTANCE
    });
    expect(response.operation?.result?.payload.case).toBe("acknowledgement");
  });

  it("rejects a stale durable generation before the Adapter can signal a PID", async () => {
    const terminateRuntimeProcess = vi.fn(async () => undefined);
    const app = application(adapter({ terminateRuntimeProcess }), 5);
    const services = createConnectServices(app);
    const mutation = create(contract.OperationMutationSchema, {
      payload: {
        case: "terminateRuntimeProcess",
        value: {
          backendId: "backend-1",
          sessionId: "session-1",
          runtimeGeneration: 4n,
          processId: 42n,
          processInstanceId: PROCESS_INSTANCE
        }
      }
    });

    await expect((services.operation.submitOperation as (
      request: unknown,
      handlerContext: unknown
    ) => Promise<contract.SubmitOperationResponse>)({
      operationId: "operation-stale-runtime",
      connectionId: connection.id,
      mutation
    }, context())).rejects.toMatchObject({ expected: 4, received: 5 });
    expect(terminateRuntimeProcess).not.toHaveBeenCalled();
  });
});

async function callBackendList(app: OrchestratorApplication): Promise<contract.ListRuntimeProcessesResponse> {
  const services = createConnectServices(app);
  return (services.backend.listRuntimeProcesses as (
    request: unknown,
    handlerContext: unknown
  ) => Promise<contract.ListRuntimeProcessesResponse>)({ backendId: "backend-1" }, context());
}

function application(
  runtimeAdapter: BackendAdapter,
  generation: number,
  order: string[] = []
): OrchestratorApplication {
  const descriptor = backendDescriptor();
  const store = {
    findOperation: () => undefined,
    getBackend: (id: string) => {
      if (id !== "backend-1") throw new Error("Backend not found");
      return { descriptor };
    },
    getSession: (id: string) => {
      if (id !== "session-1") throw new Error("Session not found");
      return { descriptor: { id, backendId: "backend-1", binding: { generation } } };
    }
  } as unknown as OperationalStore;
  const sessionHost = {
    invokeBackendAdapter: async <T>(
      backendId: string,
      effect: (adapter: BackendAdapter, backendInstanceGeneration: number) => T | Promise<T>
    ): Promise<T> => {
      if (backendId !== runtimeAdapter.id) throw new Error("Backend not found");
      return await effect(runtimeAdapter, descriptor.instanceGeneration);
    },
    mutate: async (input: {
      operationId: string;
      kind: string;
      body: unknown;
      precondition?: (value: OperationalStore) => void;
      effect?: () => Promise<void>;
      commit: (value: OperationalStore) => unknown;
    }) => {
      input.precondition?.(store);
      order.push("persist");
      await input.effect?.();
      input.precondition?.(store);
      const value = input.commit(store);
      order.push("complete");
      return {
        replayed: false,
        value,
        operation: completedRecord(input.operationId, input.kind, input.body, value)
      };
    }
  };
  return {
    config: { publicOrigin: "https://orchestrator.example.test" },
    store,
    connections: { authenticate: () => connection },
    artifacts: {},
    blobTransfers: {},
    workspaces: {},
    workspaceChanges: {},
    sessionHost,
    scheduler: {},
    adapters: [runtimeAdapter],
    browserActivity: [],
    close: async () => undefined
  } as unknown as OrchestratorApplication;
}

function backendDescriptor(): BackendDescriptor {
  return {
    id: "backend-1",
    displayName: "Local runtime",
    version: "1",
    health: "healthy",
    adapterKind: "fixture",
    instanceGeneration: 0,
    installationState: "installed",
    authenticationState: "authenticated",
    capabilities: new Map([
      ["runtime.process_usage", { key: "runtime.process_usage", supported: true }],
      ["runtime.process_terminate", { key: "runtime.process_terminate", supported: true }]
    ]),
    models: [],
    tools: [],
    diagnostics: []
  };
}

function adapter(overrides: Partial<BackendAdapter>): BackendAdapter {
  return { id: "backend-1", ...overrides } as unknown as BackendAdapter;
}

function completedRecord(id: string, kind: string, body: unknown, response: unknown): OperationRecord<unknown> {
  return {
    id,
    connectionId: connection.id,
    kind,
    body,
    bodyHash: operationBodyHash(body),
    completionMode: "external_effect",
    status: "completed",
    response,
    createdAt: 1,
    updatedAt: 2,
    revision: 1n
  };
}

function context(): unknown {
  return {
    requestHeader: new Headers({ authorization: "Bearer runtime-process-test" }),
    signal: new AbortController().signal
  };
}
