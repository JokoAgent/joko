import { create } from "@bufbuild/protobuf";
import { Code } from "@connectrpc/connect";
import * as contract from "@joko/contracts";
import { operationBodyHash, type OperationRecord } from "@joko/store";
import { describe, expect, it, vi } from "vitest";

import type { OrchestratorApplication } from "./application.js";
import { createConnectServices } from "./connect-services.js";

const owner = {
  id: "memory-owner",
  name: "Memory owner",
  authKeyDigest: "digest",
  state: "active" as const,
  pairedAt: 1,
  revision: 1n
};

describe("Connect Maker Memory owner and reset scopes", () => {
  it("authenticates the owner and treats Backend scope as a capability, not a Pi ID", async () => {
    const reset = vi.fn((scope: "curated" | "backend", backendId?: string) =>
      scope === "curated"
        ? { removedEntries: 7, removedTargets: 3 }
        : { removedEntries: backendId === "memory-capable" ? 2 : 0, removedTargets: 1 });
    const store = {
      findOperation: () => undefined,
      getBackend: (backendId: string) => ({ descriptor: backendId === "native-memory"
        ? {
            id: backendId,
            capabilities: new Map([["memory.native", { key: "memory.native", supported: true }]])
          }
        : {
            id: backendId,
            capabilities: new Map([["memory.compaction_digest", {
              key: "memory.compaction_digest",
              supported: backendId === "memory-capable"
            }]])
          } })
    };
    const services = createConnectServices(stubApplication({
      store,
      makerMemory: { reset },
      sessionHost: immediateHost(store)
    }));

    await expect(submitReset(services.operation.submitOperation, {
      operationId: "memory-wrong-owner",
      connectionId: "different-owner",
      scope: contract.MemoryResetScope.CURATED
    })).rejects.toMatchObject({ code: Code.PermissionDenied });
    expect(reset).not.toHaveBeenCalled();

    const curated = await submitReset<contract.SubmitOperationResponse>(services.operation.submitOperation, {
      operationId: "memory-reset-curated",
      connectionId: owner.id,
      scope: contract.MemoryResetScope.CURATED
    });
    expect(curated.operation?.result?.payload).toMatchObject({
      case: "memoryReset",
      value: { removedEntries: 7n, removedTargets: 3n }
    });
    expect(reset).toHaveBeenLastCalledWith("curated");

    const backend = await submitReset<contract.SubmitOperationResponse>(services.operation.submitOperation, {
      operationId: "memory-reset-capable-backend",
      connectionId: owner.id,
      scope: contract.MemoryResetScope.BACKEND,
      backendId: "memory-capable"
    });
    expect(backend.operation?.result?.payload).toMatchObject({
      case: "memoryReset",
      value: { removedEntries: 2n, removedTargets: 1n }
    });
    expect(reset).toHaveBeenLastCalledWith("backend", "memory-capable");

    await expect(submitReset(services.operation.submitOperation, {
      operationId: "memory-reset-pi-without-capability",
      connectionId: owner.id,
      scope: contract.MemoryResetScope.BACKEND,
      backendId: "pi"
    })).rejects.toMatchObject({ code: Code.FailedPrecondition });
    await expect(submitReset(services.operation.submitOperation, {
      operationId: "memory-reset-native-without-owner",
      connectionId: owner.id,
      scope: contract.MemoryResetScope.BACKEND,
      backendId: "native-memory"
    })).rejects.toMatchObject({ code: Code.FailedPrecondition });
    expect(reset).toHaveBeenCalledTimes(2);
  });

  it("rejects a stale native-memory toggle while Maker Memory is enabled and accepts an atomic switch", async () => {
    let current = { format: 1 as const, makerEnabled: true, backendEnabled: {} as Readonly<Record<string, boolean>> };
    const setSetting = vi.fn((_scope: string, _scopeId: string, _key: string, value: typeof current) => { current = value; });
    const reconcileSettingsChange = vi.fn(async () => true);
    const patchedSettings = vi.fn((patch: {
      readonly makerEnabled?: boolean;
      readonly backendId?: string;
      readonly backendEnabled?: boolean;
    }) => ({
      format: 1 as const,
      makerEnabled: patch.makerEnabled ?? current.makerEnabled,
      backendEnabled: patch.backendEnabled === undefined
        ? current.backendEnabled
        : { ...current.backendEnabled, [patch.backendId!]: patch.backendEnabled }
    }));
    const store = {
      findOperation: () => undefined,
      setSetting,
      getBackend: (backendId: string) => ({ descriptor: {
        id: backendId,
        capabilities: new Map([["memory.native", { key: "memory.native", supported: true }]])
      } })
    };
    const services = createConnectServices(stubApplication({
      store,
      makerMemory: { patchedSettings, reconcileSettingsChange },
      sessionHost: immediateHost(store)
    }));

    await expect(submitMemoryUpdate(services.operation.submitOperation, {
      operationId: "memory-native-stale-toggle",
      connectionId: owner.id,
      backendId: "native-memory",
      backendEnabled: false
    })).rejects.toMatchObject({ code: Code.FailedPrecondition });
    expect(setSetting).not.toHaveBeenCalled();
    expect(reconcileSettingsChange).not.toHaveBeenCalled();

    await submitMemoryUpdate(services.operation.submitOperation, {
      operationId: "memory-native-atomic-switch",
      connectionId: owner.id,
      makerEnabled: false,
      backendId: "native-memory",
      backendEnabled: false
    });
    expect(setSetting).toHaveBeenCalledWith("service", "orchestrator", "settings.memory", {
      format: 1,
      makerEnabled: false,
      backendEnabled: { "native-memory": false }
    });
    expect(reconcileSettingsChange).toHaveBeenCalledOnce();
  });

  it("rejects ambiguous reset scopes before deleting anything", async () => {
    const reset = vi.fn();
    const store = { findOperation: () => undefined };
    const services = createConnectServices(stubApplication({
      store,
      makerMemory: { reset },
      sessionHost: immediateHost(store)
    }));

    await expect(submitReset(services.operation.submitOperation, {
      operationId: "memory-curated-with-backend",
      connectionId: owner.id,
      scope: contract.MemoryResetScope.CURATED,
      backendId: "memory-capable"
    })).rejects.toMatchObject({ code: Code.InvalidArgument });
    await expect(submitReset(services.operation.submitOperation, {
      operationId: "memory-backend-without-id",
      connectionId: owner.id,
      scope: contract.MemoryResetScope.BACKEND
    })).rejects.toMatchObject({ code: Code.InvalidArgument });
    expect(reset).not.toHaveBeenCalled();
  });
});

function context(): unknown {
  return { requestHeader: new Headers({ authorization: "Bearer memory-test" }), signal: new AbortController().signal };
}

function stubApplication(overrides: Record<string, unknown>): OrchestratorApplication {
  return {
    config: { publicOrigin: "https://orchestrator.example.test" },
    store: {},
    connections: { authenticate: () => owner },
    artifacts: {},
    blobTransfers: {},
    artifactRepository: {},
    workspaces: {},
    workspaceChanges: {},
    sessionHost: {},
    scheduler: {},
    adapters: [],
    browserActivity: [],
    close: async () => undefined,
    ...overrides
  } as unknown as OrchestratorApplication;
}

function immediateHost(store: object) {
  return {
    mutate: async (input: {
      operationId: string;
      kind: string;
      body: unknown;
      commit: (value: object) => unknown;
    }) => {
      const value = input.commit(store);
      const operation: OperationRecord<unknown> = {
        id: input.operationId,
        connectionId: owner.id,
        kind: input.kind,
        body: input.body,
        bodyHash: operationBodyHash(input.body),
        completionMode: "external_effect",
        status: "completed",
        response: value,
        createdAt: 1,
        updatedAt: 2,
        revision: 1n
      };
      return { replayed: false, value, operation };
    }
  };
}

async function submitReset<T = unknown>(handler: unknown, input: {
  readonly operationId: string;
  readonly connectionId: string;
  readonly scope: contract.MemoryResetScope;
  readonly backendId?: string;
}): Promise<T> {
  if (typeof handler !== "function") throw new Error("submitOperation handler is missing");
  return await (handler as (request: unknown, value: unknown) => Promise<T>)({
    operationId: input.operationId,
    connectionId: input.connectionId,
    mutation: create(contract.OperationMutationSchema, {
      preconditions: [],
      payload: {
        case: "resetMemory",
        value: create(contract.ResetMemoryMutationSchema, {
          scope: input.scope,
          backendId: input.backendId ?? ""
        })
      }
    })
  }, context());
}

async function submitMemoryUpdate<T = unknown>(handler: unknown, input: {
  readonly operationId: string;
  readonly connectionId: string;
  readonly makerEnabled?: boolean;
  readonly backendId?: string;
  readonly backendEnabled?: boolean;
}): Promise<T> {
  if (typeof handler !== "function") throw new Error("submitOperation handler is missing");
  return await (handler as (request: unknown, value: unknown) => Promise<T>)({
    operationId: input.operationId,
    connectionId: input.connectionId,
    mutation: create(contract.OperationMutationSchema, {
      preconditions: [],
      payload: {
        case: "updateMemorySettings",
        value: create(contract.UpdateMemorySettingsMutationSchema, {
          patch: create(contract.MemorySettingsPatchSchema, {
            ...(input.makerEnabled === undefined ? {} : { makerEnabled: input.makerEnabled }),
            ...(input.backendId === undefined ? {} : { backendId: input.backendId }),
            ...(input.backendEnabled === undefined ? {} : { backendEnabled: input.backendEnabled })
          })
        })
      }
    })
  }, context());
}
