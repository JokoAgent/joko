import type { AppController, ControllerState } from "./controller.js";
import type {
  AppSnapshot,
  Locale,
  RuntimeProcessUsageView
} from "./model.js";

export interface RuntimeProcessDiagnosticsOwner {
  readonly version: 1;
  readonly profileId: string;
  readonly serverId: string;
  readonly connectionGeneration: string;
  readonly snapshotGeneration: string;
}

interface RuntimeProcessDiagnosticsBackendSnapshotBase {
  readonly backendId: string;
  readonly backendGeneration: string;
  readonly backendName: string;
  readonly usageSupported: boolean;
  readonly terminateSupported: boolean;
}

export interface RuntimeProcessDiagnosticsReadyBackendSnapshot extends RuntimeProcessDiagnosticsBackendSnapshotBase {
  readonly state: "ready";
  readonly capturedAt: number;
  readonly error?: never;
  readonly processes: readonly RuntimeProcessUsageView[];
}

export interface RuntimeProcessDiagnosticsErrorBackendSnapshot extends RuntimeProcessDiagnosticsBackendSnapshotBase {
  readonly state: "error";
  readonly capturedAt?: never;
  readonly error: string;
  readonly processes: readonly RuntimeProcessUsageView[];
}

export type RuntimeProcessDiagnosticsBackendSnapshot =
  | RuntimeProcessDiagnosticsReadyBackendSnapshot
  | RuntimeProcessDiagnosticsErrorBackendSnapshot;

export interface RuntimeProcessDiagnosticsSessionSnapshot {
  readonly sessionId: string;
  readonly backendId: string;
  readonly sessionName: string;
  readonly generation: string;
}

export interface RuntimeProcessDiagnosticsSnapshot {
  readonly locale: Locale;
  readonly backends: readonly RuntimeProcessDiagnosticsBackendSnapshot[];
  readonly sessions: readonly RuntimeProcessDiagnosticsSessionSnapshot[];
}

export function runtimeProcessDiagnosticsOwner(
  state: Pick<ControllerState, "activeProfile" | "connectionGeneration" | "connectionState" | "snapshot">
): RuntimeProcessDiagnosticsOwner | undefined {
  const profile = state.activeProfile;
  const connectionGeneration = state.connectionGeneration;
  if (
    profile === undefined
    || state.connectionState !== "connected"
    || connectionGeneration === undefined
    || !Number.isSafeInteger(connectionGeneration)
    || connectionGeneration < 1
    || state.snapshot.revision < 1n
    || state.snapshot.generation < 1n
  ) return undefined;
  return Object.freeze({
    version: 1,
    profileId: profile.id,
    serverId: profile.serverId,
    connectionGeneration: String(connectionGeneration),
    snapshotGeneration: state.snapshot.generation.toString()
  });
}

export function runtimeProcessDiagnosticsOwnerKey(owner: RuntimeProcessDiagnosticsOwner | undefined): string {
  return owner === undefined
    ? "unavailable"
    : `${owner.profileId}\u0000${owner.serverId}\u0000${owner.connectionGeneration}\u0000${owner.snapshotGeneration}`;
}

export function sameRuntimeProcessDiagnosticsOwner(
  left: RuntimeProcessDiagnosticsOwner | undefined,
  right: RuntimeProcessDiagnosticsOwner | undefined
): boolean {
  return left !== undefined
    && right !== undefined
    && left.version === right.version
    && left.profileId === right.profileId
    && left.serverId === right.serverId
    && left.connectionGeneration === right.connectionGeneration
    && left.snapshotGeneration === right.snapshotGeneration;
}

export async function collectRuntimeProcessDiagnostics(
  controller: Pick<AppController, "listRuntimeProcesses">,
  snapshot: AppSnapshot,
  locale: Locale,
  signal?: AbortSignal
): Promise<RuntimeProcessDiagnosticsSnapshot> {
  const backends = [...snapshot.backends]
    .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
  const results = await Promise.all(backends.map(async (backend): Promise<RuntimeProcessDiagnosticsBackendSnapshot> => {
    const backendGeneration = runtimeProcessBackendGeneration(backend.instanceGeneration);
    if (backendGeneration === undefined) throw new Error(`Backend ${backend.id} did not expose a current runtime generation.`);
    const usageCapability = backend.capabilities.get("runtime.process_usage");
    const usageSupported = usageCapability?.supported === true;
    const terminateSupported = usageSupported && backend.capabilities.get("runtime.process_terminate")?.supported === true;
    if (!usageSupported) {
      return Object.freeze({
        backendId: backend.id,
        backendGeneration,
        backendName: backend.name,
        usageSupported: false,
        terminateSupported: false,
        state: "error",
        error: runtimeProcessDiagnosticsErrorMessage(new Error(usageCapability?.reason ?? "Runtime process inspection is unsupported.")),
        processes: Object.freeze([])
      });
    }
    try {
      const result = await controller.listRuntimeProcesses(backend.id, signal);
      if (signal?.aborted) throw abortError();
      return Object.freeze({
        backendId: backend.id,
        backendGeneration,
        backendName: backend.name,
        usageSupported: true,
        terminateSupported,
        state: "ready",
        capturedAt: result.capturedAt,
        processes: Object.freeze([...result.processes])
      });
    } catch (error: unknown) {
      if (signal?.aborted) throw error;
      return Object.freeze({
        backendId: backend.id,
        backendGeneration,
        backendName: backend.name,
        usageSupported: true,
        terminateSupported,
        state: "error",
        error: runtimeProcessDiagnosticsErrorMessage(error),
        processes: Object.freeze([])
      });
    }
  }));
  if (signal?.aborted) throw abortError();
  const capableBackendIds = new Set(backends
    .filter((backend) => backend.capabilities.get("runtime.process_usage")?.supported === true)
    .map((backend) => backend.id));
  return Object.freeze({
    locale,
    backends: Object.freeze(results),
    sessions: Object.freeze(snapshot.sessions
      .filter((session) => capableBackendIds.has(session.backendId))
      .map((session) => Object.freeze({
        sessionId: session.id,
        backendId: session.backendId,
        sessionName: session.name,
        generation: session.generation.toString()
      })))
  });
}

export async function terminateRuntimeProcessWithCurrentFence(
  controller: Pick<AppController, "listRuntimeProcesses" | "terminateRuntimeProcess">,
  snapshot: AppSnapshot,
  process: RuntimeProcessUsageView,
  expectedBackendGeneration: string,
  signal?: AbortSignal,
  isCurrent: () => boolean = () => true
): Promise<void> {
  const backend = snapshot.backends.find((candidate) => candidate.id === process.backendId);
  if (process.role !== "task-host") throw new Error("The selected runtime process is read-only.");
  const session = snapshot.sessions.find((candidate) => candidate.id === process.sessionId);
  if (
    runtimeProcessBackendGeneration(backend?.instanceGeneration) !== expectedBackendGeneration
    ||
    backend?.capabilities.get("runtime.process_usage")?.supported !== true
    || backend.capabilities.get("runtime.process_terminate")?.supported !== true
    || session === undefined
    || session.backendId !== process.backendId
    || session.generation !== BigInt(process.generation)
    || !process.terminable
    || process.processInstanceId === undefined
  ) throw new Error("The selected runtime process is no longer current.");

  const refreshed = await controller.listRuntimeProcesses(process.backendId, signal);
  if (signal?.aborted) throw abortError();
  const current = refreshed.processes.find((candidate) => sameRuntimeProcessAuthority(candidate, process));
  if (current === undefined || !current.terminable || current.processInstanceId === undefined) {
    throw new Error("The selected runtime process is no longer current.");
  }
  if (!isCurrent()) throw new Error("The runtime process owner changed before termination.");
  await controller.terminateRuntimeProcess(current);
}

export function runtimeProcessBackendGeneration(value: number | undefined): string | undefined {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? String(value) : undefined;
}

export function sameRuntimeProcessAuthority(
  left: RuntimeProcessUsageView,
  right: RuntimeProcessUsageView
): boolean {
  return left.backendId === right.backendId
    && left.role === "task-host"
    && right.role === "task-host"
    && left.sessionId === right.sessionId
    && left.generation === right.generation
    && left.pid === right.pid
    && left.processInstanceId !== undefined
    && left.processInstanceId === right.processInstanceId;
}

export function runtimeProcessDiagnosticsErrorMessage(error: unknown): string {
  const fallback = "Runtime process usage could not be loaded.";
  if (!(error instanceof Error)) return fallback;
  const normalized = error.message.replace(/[\u0000-\u001f\u007f]+/gu, " ").trim();
  return normalized === "" ? fallback : normalized.slice(0, 512);
}

function abortError(): Error {
  return new DOMException("The runtime process request was cancelled.", "AbortError");
}
