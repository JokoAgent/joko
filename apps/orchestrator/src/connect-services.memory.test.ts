import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import { Code } from "@connectrpc/connect";
import * as contract from "@joko/contracts";
import {
  JokoError,
  MEMORY_NATIVE_DEFAULT_DISABLED_OPTION,
  MEMORY_NATIVE_LIVE_LOCAL_OPTION,
  MEMORY_NATIVE_RESET_LOCAL_OPTION,
  type BackendAdapter
} from "@joko/core";
import { OperationalStore, operationBodyHash, type OperationRecord } from "@joko/store";
import { describe, expect, it, vi } from "vitest";

import type { OrchestratorApplication } from "./application.js";
import { createConnectServices } from "./connect-services.js";
import { SessionHost } from "./session-host.js";

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
    const descriptor = {
      id: "native-memory",
      capabilities: new Map([["memory.native", {
        key: "memory.native",
        supported: true,
        options: [MEMORY_NATIVE_LIVE_LOCAL_OPTION, MEMORY_NATIVE_DEFAULT_DISABLED_OPTION]
      }]])
    };
    const store = {
      findOperation: () => undefined,
      setSetting,
      getBackend: () => ({ descriptor }),
      listBackends: () => [{ descriptor }],
      appendDiagnostic: vi.fn()
    };
    const reconcileNativeMemory = vi.fn(async () => "immediate" as const);
    const services = createConnectServices(stubApplication({
      store,
      makerMemory: { patchedSettings, reconcileSettingsChange },
      sessionHost: immediateHost(store, { id: descriptor.id, reconcileNativeMemory } as unknown as BackendAdapter)
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
    expect(reconcileNativeMemory).toHaveBeenCalledOnce();
    expect(store.appendDiagnostic).not.toHaveBeenCalled();
  });

  it("claims native reset before the current Adapter effect and preserves unknown native counts", async () => {
    const resetCuratedMemory = vi.fn();
    const resetNativeMemory = vi.fn(async () => ({}));
    const descriptor = {
      id: "codex-memory",
      capabilities: new Map([["memory.native", {
        key: "memory.native",
        supported: true,
        options: [MEMORY_NATIVE_LIVE_LOCAL_OPTION, MEMORY_NATIVE_DEFAULT_DISABLED_OPTION, MEMORY_NATIVE_RESET_LOCAL_OPTION]
      }]])
    };
    const store = {
      findOperation: () => undefined,
      findSetting: () => undefined,
      getBackend: () => ({ descriptor }),
      listBackends: () => [{ descriptor, revision: 1n, updatedAt: 1 }],
      listConnections: () => [],
      listTargets: () => [],
      health: () => ({ revision: 1n }),
      messageEmbeddingStatus: () => ({
        vectorAvailable: false,
        modelId: "",
        pendingCount: 0,
        runningCount: 0,
        doneCount: 0,
        failedCount: 0
      })
    };
    const memorySnapshot = {
      makerEnabled: false,
      customized: false,
      entryCount: 0,
      backendEnabled: { [descriptor.id]: true },
      backendEntryCount: { [descriptor.id]: 0 }
    };
    const services = createConnectServices(stubApplication({
      store,
      makerMemory: { reset: resetCuratedMemory, snapshot: () => memorySnapshot },
      sessionHost: immediateHost(store, {
        id: descriptor.id,
        resetNativeMemory
      } as unknown as BackendAdapter)
    }));

    const projected = await (services.settings.getSettings as unknown as (
      request: unknown,
      context: unknown
    ) => Promise<{ settings?: contract.SettingsSnapshot }>)({}, context());
    expect(projected.settings?.memory?.backends[0]).toMatchObject({
      backendId: descriptor.id,
      kind: contract.BackendMemoryKind.NATIVE_AUTO_MEMORY,
      resettable: true
    });

    const response = await submitReset<contract.SubmitOperationResponse>(services.operation.submitOperation, {
      operationId: "memory-reset-codex-native",
      connectionId: owner.id,
      scope: contract.MemoryResetScope.BACKEND,
      backendId: descriptor.id
    });

    expect(resetNativeMemory).toHaveBeenCalledOnce();
    expect(resetCuratedMemory).not.toHaveBeenCalled();
    const result = response.operation?.result?.payload;
    expect(result?.case).toBe("memoryReset");
    if (result?.case !== "memoryReset") throw new Error("Expected native Memory reset result.");
    expect(result.value.removedEntries).toBeUndefined();
    expect(result.value.removedTargets).toBeUndefined();
  });

  it("does not invoke a native reset owner unless the capability option and method agree", async () => {
    const descriptor = {
      id: "native-without-reset-owner",
      capabilities: new Map([["memory.native", {
        key: "memory.native",
        supported: true,
        options: [MEMORY_NATIVE_RESET_LOCAL_OPTION]
      }]])
    };
    const store = {
      findOperation: () => undefined,
      getBackend: () => ({ descriptor })
    };
    const services = createConnectServices(stubApplication({
      store,
      makerMemory: { reset: vi.fn() },
      sessionHost: immediateHost(store, { id: descriptor.id } as unknown as BackendAdapter)
    }));

    await expect(submitReset(services.operation.submitOperation, {
      operationId: "memory-reset-owner-missing",
      connectionId: owner.id,
      scope: contract.MemoryResetScope.BACKEND,
      backendId: descriptor.id
    })).rejects.toMatchObject({
      publicError: {
        code: "NATIVE_MEMORY_RESET_OWNER_UNAVAILABLE",
        stateMayHaveChanged: false
      }
    });
  });

  it("durably replays native reset success and unknown failure without repeating the destructive effect", async () => {
    const root = await mkdtemp(join(tmpdir(), "joko-native-memory-reset-"));
    const store = new OperationalStore(join(root, "orchestrator.db"));
    const descriptor = {
      id: "codex-durable-reset",
      displayName: "Codex",
      version: "0.153.4",
      adapterKind: "codex",
      instanceGeneration: 1,
      health: "healthy" as const,
      installationState: "installed" as const,
      authenticationState: "authenticated" as const,
      capabilities: new Map([["memory.native", {
        key: "memory.native",
        supported: true,
        options: [MEMORY_NATIVE_RESET_LOCAL_OPTION]
      }]]),
      models: [],
      tools: [],
      diagnostics: []
    };
    store.upsertBackend(descriptor);
    const connection = store.createConnection({
      id: owner.id,
      name: owner.name,
      authKeyDigest: owner.authKeyDigest
    });
    const reset = vi.fn(async () => ({}));
    let host = new SessionHost(store, {} as never, [{
      id: descriptor.id,
      resetNativeMemory: reset,
      dispose: async () => undefined
    } as unknown as BackendAdapter]);
    const servicesFor = (sessionHost: SessionHost) => createConnectServices(stubApplication({
      store,
      makerMemory: { reset: vi.fn() },
      sessionHost,
      connections: { authenticate: () => connection }
    }));

    try {
      const first = servicesFor(host);
      const input = {
        operationId: "memory-native-durable-success",
        connectionId: owner.id,
        scope: contract.MemoryResetScope.BACKEND,
        backendId: descriptor.id
      } as const;
      await expect(submitReset(first.operation.submitOperation, input)).resolves.toBeDefined();
      await expect(submitReset(first.operation.submitOperation, input)).resolves.toBeDefined();
      expect(reset).toHaveBeenCalledOnce();
      expect(store.getOperation(input.operationId)).toMatchObject({ status: "completed", response: {
        memoryReset: {}
      } });

      await host.dispose();
      const restartedReset = vi.fn(async () => {
        throw new JokoError({
          code: "CODEX_NATIVE_MEMORY_RESET_FAILED",
          message: "The native reset acknowledgement is unknown.",
          phase: "dispatch",
          retryable: false,
          stateMayHaveChanged: true,
          recovery: "Inspect native memory state before explicitly retrying."
        });
      });
      host = new SessionHost(store, {} as never, [{
        id: descriptor.id,
        resetNativeMemory: restartedReset,
        dispose: async () => undefined
      } as unknown as BackendAdapter]);
      const restarted = servicesFor(host);
      await expect(submitReset(restarted.operation.submitOperation, input)).resolves.toBeDefined();
      expect(restartedReset).not.toHaveBeenCalled();

      const failedInput = { ...input, operationId: "memory-native-durable-unknown" };
      const failed = await submitReset<contract.SubmitOperationResponse>(
        restarted.operation.submitOperation,
        failedInput
      );
      const replayedFailure = await submitReset<contract.SubmitOperationResponse>(
        restarted.operation.submitOperation,
        failedInput
      );
      expect(restartedReset).toHaveBeenCalledOnce();
      expect(failed.operation).toMatchObject({
        state: contract.OperationState.FAILED,
        error: { code: "CODEX_NATIVE_MEMORY_RESET_FAILED" }
      });
      expect(replayedFailure.operation).toMatchObject({
        state: contract.OperationState.FAILED,
        error: { code: "CODEX_NATIVE_MEMORY_RESET_FAILED" }
      });
      expect(store.getOperation(failedInput.operationId)).toMatchObject({
        status: "failed",
        error: {
          code: "CODEX_NATIVE_MEMORY_RESET_FAILED",
          stateMayHaveChanged: true
        }
      });
    } finally {
      await host.dispose();
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps the durable native-memory choice and records a content-free diagnostic when live reconcile fails", async () => {
    const current = { format: 1 as const, makerEnabled: false, backendEnabled: {} as Readonly<Record<string, boolean>> };
    const descriptor = {
      id: "native-memory",
      capabilities: new Map([["memory.native", {
        key: "memory.native",
        supported: true,
        options: [MEMORY_NATIVE_LIVE_LOCAL_OPTION, MEMORY_NATIVE_DEFAULT_DISABLED_OPTION]
      }]])
    };
    const setSetting = vi.fn();
    const appendDiagnostic = vi.fn();
    const store = {
      findOperation: () => undefined,
      setSetting,
      getBackend: () => ({ descriptor }),
      listBackends: () => [{ descriptor }],
      appendDiagnostic
    };
    const services = createConnectServices(stubApplication({
      store,
      makerMemory: {
        patchedSettings: (patch: { readonly backendId?: string; readonly backendEnabled?: boolean }) => ({
          ...current,
          backendEnabled: { [patch.backendId!]: patch.backendEnabled! }
        }),
        reconcileSettingsChange: vi.fn(async () => true)
      },
      sessionHost: immediateHost(store, {
        id: descriptor.id,
        reconcileNativeMemory: async () => { throw new Error("private runtime failure"); }
      } as unknown as BackendAdapter)
    }));

    await expect(submitMemoryUpdate(services.operation.submitOperation, {
      operationId: "memory-native-live-reconcile-failure",
      connectionId: owner.id,
      backendId: descriptor.id,
      backendEnabled: true
    })).resolves.toBeDefined();
    expect(setSetting).toHaveBeenCalledWith("service", "orchestrator", "settings.memory", {
      format: 1,
      makerEnabled: false,
      backendEnabled: { "native-memory": true }
    });
    expect(appendDiagnostic).toHaveBeenCalledWith(expect.objectContaining({
      code: "NATIVE_MEMORY_RECONCILIATION_FAILED",
      details: { backendIds: ["native-memory"] }
    }));
    expect(JSON.stringify(appendDiagnostic.mock.calls)).not.toContain("private runtime failure");
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

function immediateHost(store: object, adapter?: BackendAdapter) {
  return {
    mutate: async (input: {
      operationId: string;
      kind: string;
      body: unknown;
      commit: (value: object) => unknown;
      precondition?: (value: object) => void;
      effect?: () => Promise<void>;
    }) => {
      input.precondition?.(store);
      await input.effect?.();
      input.precondition?.(store);
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
    },
    invokeBackendAdapter: async <T>(
      backendId: string,
      effect: (value: BackendAdapter, generation: number) => T | Promise<T>
    ): Promise<T> => {
      if (adapter === undefined || adapter.id !== backendId) throw new Error("Backend adapter unavailable");
      return await effect(adapter, 1);
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
