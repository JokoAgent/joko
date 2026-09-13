import {
  JokoError,
  type BackendAdapter,
  type RuntimeProcessUsage,
  type RuntimeProcessUsageSnapshot,
  type TerminateRuntimeProcessInput
} from "@joko/core";
import type { OperationalStore } from "@joko/store";

export interface ProjectedRuntimeProcessUsage extends RuntimeProcessUsage {
  readonly backendId: string;
}

export interface ProjectedRuntimeProcessUsageSnapshot {
  readonly capturedAt: number;
  readonly processes: readonly ProjectedRuntimeProcessUsage[];
}

export interface RuntimeProcessTerminationFence extends TerminateRuntimeProcessInput {
  readonly backendId: string;
}

export type BackendAdapterEffectInvoker = <T>(
  backendId: string,
  effect: (adapter: BackendAdapter, backendInstanceGeneration: number) => T | Promise<T>
) => Promise<T>;

/**
 * Capability-neutral Orchestrator boundary for display-safe local process metrics.
 * The owning Adapter remains the sole holder of OS birth identities.
 */
export class RuntimeProcessControl {
  readonly #store: OperationalStore;
  readonly #invokeBackendAdapter: BackendAdapterEffectInvoker;

  constructor(
    store: OperationalStore,
    invokeBackendAdapter: BackendAdapterEffectInvoker
  ) {
    this.#store = store;
    this.#invokeBackendAdapter = invokeBackendAdapter;
  }

  async list(backendId: string): Promise<ProjectedRuntimeProcessUsageSnapshot> {
    const normalizedBackendId = boundedIdentity(backendId, "Backend");
    return this.#invokeBackendAdapter(normalizedBackendId, async (adapter) => {
      const backend = this.#store.getBackend(normalizedBackendId).descriptor;
      if (
        backend.capabilities.get("runtime.process_usage")?.supported !== true
        || adapter.getRuntimeProcessUsage === undefined
      ) throw runtimeProcessError(
        "RUNTIME_PROCESS_USAGE_UNSUPPORTED",
        "The selected Backend does not support local runtime process inspection.",
        "Select a Backend that advertises runtime.process_usage."
      );

      const snapshot = await adapter.getRuntimeProcessUsage();
      if (!Number.isSafeInteger(snapshot.capturedAt) || snapshot.capturedAt < 0) {
        throw invalidSnapshot("The Backend returned an invalid process capture time.");
      }
      const canTerminate = backend.capabilities.get("runtime.process_terminate")?.supported === true
        && adapter.terminateRuntimeProcess !== undefined;
      const identities = new Set<string>();
      const processes = snapshot.processes.map((process) => {
        validateUsage(process);
        const session = this.#store.getSession(process.sessionId).descriptor;
        if (
          session.backendId !== normalizedBackendId
          || session.binding.generation !== process.generation
        ) throw invalidSnapshot("The Backend returned a process outside its current Session generation.");
        const identity = `${process.sessionId}\0${process.generation}\0${process.pid}`;
        if (identities.has(identity)) throw invalidSnapshot("The Backend returned a duplicate runtime process root.");
        identities.add(identity);

        const terminable = canTerminate && process.terminable;
        if (terminable && !validProcessInstanceId(process.processInstanceId)) {
          throw invalidSnapshot("The Backend returned a terminable process without a valid spawn fence.");
        }
        return {
          backendId: normalizedBackendId,
          sessionId: process.sessionId,
          generation: process.generation,
          pid: process.pid,
          cpuPercent: process.cpuPercent,
          memoryKb: process.memoryKb,
          processCount: process.processCount,
          terminable,
          ...(terminable ? { processInstanceId: process.processInstanceId } : {})
        } satisfies ProjectedRuntimeProcessUsage;
      });
      return { capturedAt: snapshot.capturedAt, processes };
    });
  }

  /** Repeats every durable/public fence immediately before entering Adapter code. */
  async terminate(input: RuntimeProcessTerminationFence): Promise<void> {
    const backendId = boundedIdentity(input.backendId, "Backend");
    const sessionId = boundedIdentity(input.sessionId, "Session");
    if (!Number.isSafeInteger(input.generation) || input.generation < 1) {
      throw runtimeProcessFenceError("Runtime generation is invalid.");
    }
    if (!Number.isSafeInteger(input.pid) || input.pid < 1) {
      throw runtimeProcessFenceError("Process ID is invalid.");
    }
    if (!validProcessInstanceId(input.processInstanceId)) {
      throw runtimeProcessFenceError("Process instance fence is invalid.");
    }

    await this.#invokeBackendAdapter(backendId, async (adapter) => {
      const backend = this.#store.getBackend(backendId).descriptor;
      if (
        backend.capabilities.get("runtime.process_terminate")?.supported !== true
        || adapter.terminateRuntimeProcess === undefined
      ) throw runtimeProcessError(
        "RUNTIME_PROCESS_TERMINATE_UNSUPPORTED",
        "The selected Backend does not support terminating local runtime processes.",
        "Select a Backend that advertises runtime.process_terminate."
      );
      const session = this.#store.getSession(sessionId).descriptor;
      if (session.backendId !== backendId || session.binding.generation !== input.generation) {
        throw runtimeProcessFenceError("The selected process no longer belongs to the current Session generation.");
      }
      await adapter.terminateRuntimeProcess({
        sessionId,
        generation: input.generation,
        pid: input.pid,
        processInstanceId: input.processInstanceId
      });
    });
  }
}

function validateUsage(process: RuntimeProcessUsage): void {
  boundedIdentity(process.sessionId, "Session");
  if (!Number.isSafeInteger(process.generation) || process.generation < 1) {
    throw invalidSnapshot("The Backend returned an invalid runtime generation.");
  }
  if (!Number.isSafeInteger(process.pid) || process.pid < 1) {
    throw invalidSnapshot("The Backend returned an invalid process ID.");
  }
  if (!Number.isFinite(process.cpuPercent) || process.cpuPercent < 0) {
    throw invalidSnapshot("The Backend returned an invalid CPU measurement.");
  }
  if (!Number.isSafeInteger(process.memoryKb) || process.memoryKb < 0) {
    throw invalidSnapshot("The Backend returned an invalid memory measurement.");
  }
  if (!Number.isSafeInteger(process.processCount) || process.processCount < 1) {
    throw invalidSnapshot("The Backend returned an invalid process count.");
  }
}

function boundedIdentity(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized === "" || normalized.length > 512 || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw runtimeProcessFenceError(`${label} identity is invalid.`);
  }
  return normalized;
}

function validProcessInstanceId(value: string | undefined): value is string {
  return value !== undefined
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

function invalidSnapshot(message: string): JokoError {
  return runtimeProcessError(
    "RUNTIME_PROCESS_SNAPSHOT_INVALID",
    message,
    "Refresh Backend state and retry only after process inspection is healthy."
  );
}

function runtimeProcessFenceError(message: string): JokoError {
  return runtimeProcessError(
    "RUNTIME_PROCESS_FENCE_MISMATCH",
    message,
    "Refresh runtime process usage before attempting termination again."
  );
}

function runtimeProcessError(code: string, message: string, recovery: string): JokoError {
  return new JokoError({
    code,
    message,
    phase: "runtime_process",
    retryable: code !== "RUNTIME_PROCESS_SNAPSHOT_INVALID",
    stateMayHaveChanged: false,
    recovery
  });
}
