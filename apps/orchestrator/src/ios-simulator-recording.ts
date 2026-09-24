import { JokoError, type BlobRef } from "@joko/core";
import { createSimulatorLifecycleRuntime, MacSimulatorRecordingRuntime,
  SimulatorRecordingRuntimeError, type SimulatorLifecycleRuntime,
  type SimulatorRecordingHandle, type SimulatorRecordingRuntime } from "@joko/tool-ios-simulator";
import { OperationConflictError, OperationInProgressError, OperationPreviouslyFailedError,
  type OperationalStore } from "@joko/store";
import type { ArtifactStore } from "./artifact-store.js";
import type { SimulatorDriverCoordinator } from "./ios-simulator-driver-coordinator.js";
import type { SimulatorLifecycleEffectAuthority } from "./ios-simulator-lifecycle-coordinator.js";
import { SimulatorOwnershipError, type PublicSimulatorInstance,
  type SimulatorInstanceRoute, type SimulatorOwnershipRegistry,
  type SimulatorTaskScope } from "./ios-simulator-ownership.js";

const KIND = "ios_simulator_recording";
const DIGEST = /^[0-9a-f]{64}$/u;
const BODY_HASH = /^sha256:[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu;
const CONFLICTING_KINDS = new Set([KIND, "ios_simulator_instance_control", "ios_simulator_create",
  "ios_simulator_lifecycle", "ios_simulator_driver", "ios_simulator_input",
  "ios_simulator_state_control", "ios_simulator_app_build", "ios_simulator_app_install",
  "ios_simulator_app_control", "ios_simulator_url_control", "ios_simulator_screenshot",
  "ios_simulator_visual_capture", "ios_simulator_grace_cleanup",
  "ios_simulator_removed_cleanup"]);

export interface SimulatorRecordingStartReceipt {
  readonly recordingId: string;
  readonly instanceId: string;
  readonly generation: number;
  readonly startedAt: string;
  readonly backend: "simctl";
}

export interface SimulatorRecordingStopReceipt {
  readonly recordingId: string;
  readonly instanceId: string;
  readonly generation: number;
  readonly stoppedAt: string;
  readonly backend: "simctl";
  readonly video: BlobRef;
}

export class SimulatorRecordingError extends JokoError {
  constructor(readonly code: string, message: string) {
    super({ code, message, phase: "simulator_recording", retryable: false,
      stateMayHaveChanged: code === "RECORDING_OUTCOME_UNKNOWN",
      recovery: code === "RECORDING_OUTCOME_UNKNOWN"
        ? "Inspect the exact Simulator and task artifact before requesting another recording."
        : "Inspect the current Simulator task and use a new request if needed." });
    this.name = "SimulatorRecordingError";
  }
}

interface ActiveRecording {
  readonly handle: SimulatorRecordingHandle;
  readonly scope: SimulatorTaskScope;
  readonly route: SimulatorInstanceRoute;
  readonly startedAt: string;
  readonly monitor: ReturnType<typeof setInterval>;
  retiring: boolean;
  finishing: boolean;
  cleanup?: Promise<void>;
  pendingFailure?: { readonly operationId: string; readonly bodyHash: string; readonly error: Error };
}

type RecordingArtifacts = Pick<ArtifactStore, "ingestFileHandle" | "get">;
type RecordingDevice = Pick<SimulatorLifecycleRuntime, "findExact">;
type RecordingDriver = Pick<SimulatorDriverCoordinator, "isReady">;

/** Durable start/stop receipts around a parent-bound native recorder, with exact task and instance ownership. */
export class SimulatorRecordingCoordinator {
  readonly #store: OperationalStore;
  readonly #ownership: SimulatorOwnershipRegistry;
  readonly #driver: RecordingDriver;
  readonly #artifacts: RecordingArtifacts;
  readonly #runtime: SimulatorRecordingRuntime;
  readonly #device: RecordingDevice;
  readonly #now: () => number;
  readonly #active = new Map<string, ActiveRecording>();

  constructor(store: OperationalStore, ownership: SimulatorOwnershipRegistry,
    driver: RecordingDriver, artifacts: RecordingArtifacts, rootDirectory: string,
    options: { readonly runtime?: SimulatorRecordingRuntime; readonly device?: RecordingDevice;
      readonly now?: () => number } = {}) {
    this.#store = store;
    this.#ownership = ownership;
    this.#driver = driver;
    this.#artifacts = artifacts;
    this.#runtime = options.runtime ?? new MacSimulatorRecordingRuntime({ rootDirectory });
    this.#device = options.device ?? createSimulatorLifecycleRuntime();
    this.#now = options.now ?? Date.now;
  }

  hasActive(instanceId: string): boolean { return this.#active.has(instanceId); }

  async start(scope: SimulatorTaskScope, route: SimulatorInstanceRoute,
    authority: SimulatorLifecycleEffectAuthority, signal?: AbortSignal): Promise<{
      readonly receipt: SimulatorRecordingStartReceipt; readonly replayed: boolean }> {
    this.#validate(authority, signal);
    const operationId = `ios-simulator-recording:${authority.effectIdentity}`;
    let instance: PublicSimulatorInstance | undefined;
    let claim;
    try {
      claim = this.#store.claimDeferredEffectOperation<SimulatorRecordingStartReceipt>({ id: operationId,
        kind: KIND, body: this.#body("start_recording", scope, route, authority) }, () => {
        instance = this.#requireReady(scope, route);
        if (this.#active.has(route.instanceId)) throw new SimulatorRecordingError("RECORDING_ALREADY_ACTIVE",
          "This Simulator already has an active recording.");
        this.#requireNoConflict(operationId, scope.sessionId);
      });
    } catch (error) { throw this.#admissionFailure(error); }
    if (!claim.claimed) {
      this.#ownership.requireRoute(scope, route);
      const active = this.#active.get(route.instanceId);
      if (!active || active.handle.recordingId !== claim.value.recordingId) {
        throw new SimulatorRecordingError("RECORDING_NOT_FOUND",
          "The earlier recording is no longer active and cannot be started again by replay.");
      }
      return { receipt: claim.value, replayed: true };
    }
    if (!instance) throw new Error("Simulator recording admission did not resolve its instance.");
    let attempted = false;
    let handle: SimulatorRecordingHandle | undefined;
    try {
      await this.#requireBooted(instance, signal);
      this.#ownership.requireRoute(scope, route);
      if (signal?.aborted) throw new SimulatorRecordingError("MUTATION_CANCELLED",
        "Simulator recording was cancelled before dispatch.");
      attempted = true;
      handle = await this.#runtime.start(instance.simulatorUdid, signal);
      const startedAt = new Date(this.#now()).toISOString();
      const active: ActiveRecording = { handle, scope, route, startedAt, retiring: false, finishing: false,
        monitor: setInterval(() => { void this.#monitor(route.instanceId); }, 5_000) };
      active.monitor.unref?.();
      this.#active.set(route.instanceId, active);
      this.#requireReady(scope, route);
      const completed = this.#store.completeDeferredEffectOperation<SimulatorRecordingStartReceipt>(
        operationId, claim.operation.bodyHash, () => {
          this.#requireReady(scope, route);
          return { recordingId: handle!.recordingId, instanceId: instance!.instanceId,
            generation: instance!.generation, startedAt, backend: "simctl" };
        });
      return { receipt: completed.value, replayed: completed.replayed };
    } catch (error) {
      const safe = this.#failure(error, attempted, signal);
      const active = this.#active.get(route.instanceId);
      if (active && handle && active.handle.recordingId === handle.recordingId) {
        active.retiring = true;
        active.pendingFailure = { operationId, bodyHash: claim.operation.bodyHash, error: safe };
        await this.#cleanupActive(route.instanceId, active).catch(() => undefined);
      } else if (handle) {
        let discarded = true;
        await this.#runtime.discard(handle).catch(() => { discarded = false; });
        if (discarded) this.#failClaim(operationId, claim.operation.bodyHash, safe);
      } else if (!(error instanceof SimulatorRecordingRuntimeError && error.cleanupUncertain)) {
        this.#failClaim(operationId, claim.operation.bodyHash, safe);
      }
      throw safe;
    }
  }

  async stop(scope: SimulatorTaskScope, route: SimulatorInstanceRoute, recordingId: string,
    authority: SimulatorLifecycleEffectAuthority, signal?: AbortSignal): Promise<{
      readonly receipt: SimulatorRecordingStopReceipt; readonly replayed: boolean }> {
    this.#validate(authority, signal);
    if (!UUID.test(recordingId)) throw new SimulatorRecordingError("INVALID_ARGUMENT",
      "Simulator recording identity is invalid.");
    const operationId = `ios-simulator-recording:${authority.effectIdentity}`;
    let active: ActiveRecording | undefined;
    let claim;
    try {
      claim = this.#store.claimDeferredEffectOperation<SimulatorRecordingStopReceipt>({ id: operationId,
        kind: KIND, body: { ...this.#body("stop_recording", scope, route, authority), recordingId } }, () => {
        this.#requireReady(scope, route);
        active = this.#active.get(route.instanceId);
        if (!active || active.retiring || active.handle.recordingId !== recordingId ||
            active.scope.sessionId !== scope.sessionId || active.scope.targetId !== scope.targetId ||
            active.scope.generation !== scope.generation || active.route.generation !== route.generation ||
            active.route.leaseId !== route.leaseId) throw new SimulatorRecordingError(
          "RECORDING_NOT_FOUND", "Recording does not belong to this current Simulator instance.");
        this.#requireNoConflict(operationId, scope.sessionId);
      });
    } catch (error) { throw this.#admissionFailure(error); }
    if (!claim.claimed) {
      this.#ownership.requireRoute(scope, route);
      const artifact = await this.#artifacts.get(claim.value.video.id).catch(() => undefined);
      if (!artifact || artifact.sha256 !== claim.value.video.sha256 ||
          artifact.byteLength !== claim.value.video.byteLength ||
          artifact.mimeType !== claim.value.video.mimeType) throw new SimulatorRecordingError(
        "RECORDING_ARTIFACT_UNAVAILABLE", "The earlier recording artifact is unavailable.");
      return { receipt: claim.value, replayed: true };
    }
    if (!active) throw new Error("Simulator recording admission did not resolve its active handle.");
    active.finishing = true;
    let attempted = false;
    try {
      this.#requireReady(scope, route);
      attempted = true;
      const output = await this.#runtime.stop(active.handle, signal);
      let video: BlobRef;
      try {
        this.#requireReady(scope, route);
        const artifact = await this.#artifacts.ingestFileHandle(output.file, {
          expectedSize: output.byteLength, mimeType: "video/quicktime",
          fileName: `simulator-${recordingId}.mov`, signal,
          beforeFinalize: async () => { this.#requireReady(scope, route); }
        });
        video = { id: artifact.id, sha256: artifact.sha256, byteLength: artifact.byteLength,
          mimeType: artifact.mimeType, fileName: artifact.fileName };
      } finally { await output.file.close(); }
      this.#requireReady(scope, route);
      await this.#runtime.release(active.handle);
      clearInterval(active.monitor);
      this.#active.delete(route.instanceId);
      const completed = this.#store.completeDeferredEffectOperation<SimulatorRecordingStopReceipt>(
        operationId, claim.operation.bodyHash, () => {
          this.#ownership.requireRoute(scope, route);
          return { recordingId, instanceId: route.instanceId, generation: route.generation,
            stoppedAt: new Date(this.#now()).toISOString(), backend: "simctl", video };
        });
      return { receipt: completed.value, replayed: completed.replayed };
    } catch (error) {
      const safe = this.#failure(error, attempted, signal);
      active.finishing = false;
      active.retiring = true;
      active.pendingFailure = { operationId, bodyHash: claim.operation.bodyHash, error: safe };
      await this.#cleanupActive(route.instanceId, active).catch(() => undefined);
      throw safe;
    }
  }

  async discardInstance(instanceId: string): Promise<void> {
    const active = this.#active.get(instanceId);
    if (!active) return;
    active.retiring = true;
    await this.#cleanupActive(instanceId, active);
  }

  async close(): Promise<void> {
    for (const active of this.#active.values()) clearInterval(active.monitor);
    await this.#runtime.close();
    this.#active.clear();
  }

  async #monitor(instanceId: string): Promise<void> {
    const active = this.#active.get(instanceId);
    if (!active) return;
    if (active.retiring) {
      await this.#cleanupActive(instanceId, active).catch(() => undefined);
      return;
    }
    try {
      if (!this.#runtime.isActive(active.handle)) throw new SimulatorRecordingError(
        "RECORDING_FAILED", "Simulator recorder exited unexpectedly.");
      this.#ownership.heartbeatRoute(active.scope, active.route);
      this.#requireReady(active.scope, active.route);
    } catch {
      if (!active.finishing) await this.discardInstance(instanceId).catch(() => undefined);
    }
  }

  async #cleanupActive(instanceId: string, active: ActiveRecording): Promise<void> {
    if (active.cleanup) return active.cleanup;
    active.cleanup = (async () => {
      await this.#runtime.discard(active.handle);
      if (active.pendingFailure) this.#failClaim(active.pendingFailure.operationId,
        active.pendingFailure.bodyHash, active.pendingFailure.error);
      clearInterval(active.monitor);
      if (this.#active.get(instanceId) === active) this.#active.delete(instanceId);
    })();
    try { await active.cleanup; }
    finally { active.cleanup = undefined; }
  }

  #failClaim(operationId: string, bodyHash: string, error: Error): void {
    try { this.#store.failEffectOperation(operationId, bodyHash, error); }
    catch { /* Store recovery keeps an unconfirmed effect fenced. */ }
  }

  #validate(authority: SimulatorLifecycleEffectAuthority, signal?: AbortSignal): void {
    if (!DIGEST.test(authority.effectIdentity) || !BODY_HASH.test(authority.requestBodyHash) ||
        !Number.isSafeInteger(authority.providerGeneration) || authority.providerGeneration < 1) {
      throw new SimulatorRecordingError("INVALID_ARGUMENT", "Simulator recording authority is invalid.");
    }
    if (signal?.aborted) throw new SimulatorRecordingError("MUTATION_CANCELLED",
      "Simulator recording was cancelled before admission.");
  }

  #body(action: "start_recording" | "stop_recording", scope: SimulatorTaskScope,
    route: SimulatorInstanceRoute, authority: SimulatorLifecycleEffectAuthority) {
    return { action, sessionId: scope.sessionId, targetId: scope.targetId,
      bindingGeneration: scope.generation, instanceId: route.instanceId,
      instanceGeneration: route.generation, leaseId: route.leaseId,
      requestBodyHash: authority.requestBodyHash, providerGeneration: authority.providerGeneration };
  }

  #requireReady(scope: SimulatorTaskScope, route: SimulatorInstanceRoute): PublicSimulatorInstance {
    const instance = this.#ownership.requireRoute(scope, route);
    if (instance.lifecycleState !== "ready" || instance.viewerState !== "attached" ||
        !this.#driver.isReady(instance)) throw new SimulatorRecordingError("SIMULATOR_NOT_READY",
      "Simulator must be booted, attached and driver-ready for recording.");
    return instance;
  }

  async #requireBooted(instance: PublicSimulatorInstance, signal?: AbortSignal): Promise<void> {
    const device = await this.#device.findExact(instance.simulatorUdid, signal);
    if (!device || !device.isAvailable || device.state !== "Booted" ||
        device.runtimeIdentifier !== instance.runtimeIdentifier ||
        device.deviceTypeIdentifier !== instance.deviceTypeIdentifier) throw new SimulatorRecordingError(
      "SIMULATOR_NOT_READY", "The exact Simulator is not available and booted for recording.");
  }

  #requireNoConflict(operationId: string, sessionId: string): void {
    let offset = 0;
    for (;;) {
      const page = this.#store.listOperations({ sessionId, status: "started", limit: 500, offset });
      const conflict = page.find(operation => operation.id !== operationId &&
        CONFLICTING_KINDS.has(operation.kind));
      if (conflict) throw new OperationInProgressError(conflict.id);
      if (page.length < 500) return;
      offset += page.length;
    }
  }

  #admissionFailure(error: unknown): Error {
    if (error instanceof OperationPreviouslyFailedError) {
      const stored = error.storedError;
      const code = stored && typeof stored === "object" && !Array.isArray(stored) &&
        typeof (stored as Record<string, unknown>)["code"] === "string"
        ? String((stored as Record<string, unknown>)["code"]) : "RECORDING_OUTCOME_UNKNOWN";
      return new SimulatorRecordingError(code, "This recording request failed and will not dispatch again.");
    }
    if (error instanceof OperationConflictError) return new SimulatorRecordingError(
      "MUTATION_CONFLICT", "Simulator recording identity was used with different arguments.");
    if (error instanceof OperationInProgressError) return new SimulatorRecordingError(
      "MUTATION_IN_PROGRESS", "Another Simulator effect is in progress.");
    return error instanceof Error ? error : new SimulatorRecordingError("RECORDING_FAILED",
      "Simulator recording admission failed.");
  }

  #failure(error: unknown, attempted: boolean, signal?: AbortSignal): Error {
    if (error instanceof SimulatorRecordingRuntimeError && error.code === "RECORDING_INVALID") {
      return new SimulatorRecordingError("RECORDING_INVALID", error.message);
    }
    if (error instanceof SimulatorRecordingRuntimeError && error.code === "RECORDING_UNAVAILABLE") {
      return new SimulatorRecordingError("RECORDING_UNAVAILABLE", error.message);
    }
    if (!attempted && (error instanceof SimulatorRecordingError ||
        error instanceof SimulatorRecordingRuntimeError || error instanceof SimulatorOwnershipError)) return error;
    if (!attempted && signal?.aborted) return new SimulatorRecordingError("MUTATION_CANCELLED",
      "Simulator recording was cancelled before dispatch.");
    return new SimulatorRecordingError("RECORDING_OUTCOME_UNKNOWN",
      "Simulator recording outcome is unknown; inspect the exact task and device before retrying.");
  }
}
