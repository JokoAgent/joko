import type { BackendAdapter, BackendDescriptor } from "@joko/core";
import type { OperationalStore } from "@joko/store";
import { describe, expect, it, vi } from "vitest";
import { RuntimeProcessControl } from "./runtime-process-control.js";

const INSTANCE = "10000000-0000-4000-8000-000000000001";

describe("RuntimeProcessControl", () => {
  it("projects only a current Adapter-owned Session generation and keeps OS identity unrepresentable", async () => {
    const terminate = vi.fn(async () => undefined);
    const runtime = adapter({
      getRuntimeProcessUsage: async () => ({
        capturedAt: 1_000,
        processes: [{
          sessionId: "session-1",
          generation: 4,
          pid: 42,
          cpuPercent: 12.5,
          memoryKb: 2_048,
          processCount: 3,
          terminable: true,
          processInstanceId: INSTANCE
        }]
      }),
      terminateRuntimeProcess: terminate
    });
    const control = new RuntimeProcessControl(
      store(["runtime.process_usage", "runtime.process_terminate"]),
      (_backendId, effect) => Promise.resolve(effect(runtime, 0))
    );

    await expect(control.list("backend-1")).resolves.toEqual({
      capturedAt: 1_000,
      processes: [{
        backendId: "backend-1",
        sessionId: "session-1",
        generation: 4,
        pid: 42,
        cpuPercent: 12.5,
        memoryKb: 2_048,
        processCount: 3,
        terminable: true,
        processInstanceId: INSTANCE
      }]
    });
    await control.terminate({
      backendId: "backend-1",
      sessionId: "session-1",
      generation: 4,
      pid: 42,
      processInstanceId: INSTANCE
    });
    expect(terminate).toHaveBeenCalledWith({
      sessionId: "session-1",
      generation: 4,
      pid: 42,
      processInstanceId: INSTANCE
    });
  });

  it("withholds the action token unless termination is independently advertised", async () => {
    const runtime = adapter({
      getRuntimeProcessUsage: async () => ({
        capturedAt: 1_000,
        processes: [{
          sessionId: "session-1",
          generation: 4,
          pid: 42,
          cpuPercent: 0,
          memoryKb: 0,
          processCount: 1,
          terminable: true,
          processInstanceId: INSTANCE
        }]
      }),
      terminateRuntimeProcess: async () => undefined
    });
    const control = new RuntimeProcessControl(
      store(["runtime.process_usage"]),
      (_backendId, effect) => Promise.resolve(effect(runtime, 0))
    );

    await expect(control.list("backend-1")).resolves.toMatchObject({
      processes: [{ terminable: false }]
    });
    expect((await control.list("backend-1")).processes[0]).not.toHaveProperty("processInstanceId");
  });

  it("fails closed before Adapter termination when any durable fence is stale", async () => {
    const terminate = vi.fn(async () => undefined);
    const runtime = adapter({ terminateRuntimeProcess: terminate });
    const control = new RuntimeProcessControl(
      store(["runtime.process_terminate"]),
      (_backendId, effect) => Promise.resolve(effect(runtime, 0))
    );

    await expect(control.terminate({
      backendId: "backend-1",
      sessionId: "session-1",
      generation: 3,
      pid: 42,
      processInstanceId: INSTANCE
    })).rejects.toMatchObject({ publicError: { code: "RUNTIME_PROCESS_FENCE_MISMATCH" } });
    await expect(control.terminate({
      backendId: "backend-1",
      sessionId: "session-1",
      generation: 4,
      pid: 42,
      processInstanceId: "not-a-spawn-fence"
    })).rejects.toMatchObject({ publicError: { code: "RUNTIME_PROCESS_FENCE_MISMATCH" } });
    expect(terminate).not.toHaveBeenCalled();
  });

  it("rejects malformed or cross-generation Adapter snapshots instead of exposing them", async () => {
    const runtime = adapter({
      getRuntimeProcessUsage: async () => ({
        capturedAt: 1_000,
        processes: [{
          sessionId: "session-1",
          generation: 3,
          pid: 42,
          cpuPercent: 0,
          memoryKb: 0,
          processCount: 1,
          terminable: false
        }]
      })
    });
    const malformed = new RuntimeProcessControl(
      store(["runtime.process_usage"]),
      (_backendId, effect) => Promise.resolve(effect(runtime, 0))
    );
    await expect(malformed.list("backend-1")).rejects.toMatchObject({
      publicError: { code: "RUNTIME_PROCESS_SNAPSHOT_INVALID" }
    });
  });

  it("resolves the current Adapter at call time after a Backend instance switch", async () => {
    const first = adapter({
      getRuntimeProcessUsage: async () => ({ capturedAt: 1, processes: [] })
    });
    const second = adapter({
      getRuntimeProcessUsage: async () => ({ capturedAt: 2, processes: [] })
    });
    let current = first;
    let invocationCount = 0;
    const invokeBackendAdapter = async <T>(
      backendId: string,
      effect: (adapter: BackendAdapter, backendInstanceGeneration: number) => T | Promise<T>
    ): Promise<T> => {
      invocationCount += 1;
      expect(backendId).toBe("backend-1");
      return Promise.resolve(effect(current, current === first ? 1 : 2));
    };
    const control = new RuntimeProcessControl(store(["runtime.process_usage"]), invokeBackendAdapter);

    await expect(control.list("backend-1")).resolves.toMatchObject({ capturedAt: 1 });
    current = second;
    await expect(control.list("backend-1")).resolves.toMatchObject({ capturedAt: 2 });
    expect(invocationCount).toBe(2);
  });
});

function store(capabilities: readonly string[]): OperationalStore {
  const descriptor = backendDescriptor(capabilities);
  return {
    getBackend: (id: string) => {
      if (id !== "backend-1") throw new Error("Backend not found");
      return { descriptor };
    },
    getSession: (id: string) => {
      if (id !== "session-1") throw new Error("Session not found");
      return { descriptor: { id, backendId: "backend-1", binding: { generation: 4 } } };
    }
  } as unknown as OperationalStore;
}

function backendDescriptor(capabilities: readonly string[]): BackendDescriptor {
  return {
    id: "backend-1",
    displayName: "Local runtime",
    version: "1",
    health: "healthy",
    adapterKind: "fixture",
    instanceGeneration: 0,
    installationState: "installed",
    authenticationState: "authenticated",
    capabilities: new Map(capabilities.map((key) => [key, { key, supported: true }])),
    models: [],
    tools: [],
    diagnostics: []
  };
}

function adapter(overrides: Partial<BackendAdapter>): BackendAdapter {
  return { id: "backend-1", ...overrides } as unknown as BackendAdapter;
}
