import {
  createSimulatorCreateRuntime, createSimulatorLifecycleRuntime,
  SimulatorCreateError, SimulatorLifecycleError,
  type SimulatorCreateRuntime, type SimulatorLifecycleRuntime
} from "@joko/tool-ios-simulator";
import { OperationInProgressError, type OperationalStore } from "@joko/store";
import {
  SimulatorOwnershipError, SimulatorOwnershipRegistry,
  type PublicSimulatorInstance, type SimulatorTaskScope
} from "./ios-simulator-ownership.js";
import {
  SimulatorPendingCreateError, SimulatorPendingCreateRegistry, type SimulatorPendingCreateRecord
} from "./ios-simulator-pending-create.js";
import type { SimulatorLifecycleEffectAuthority } from "./ios-simulator-lifecycle-coordinator.js";

const KIND = "ios_simulator_create";
const DIGEST = /^[0-9a-f]{64}$/u;
const BODY_HASH = /^sha256:[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const IOS_RUNTIME = /^com\.apple\.CoreSimulator\.SimRuntime\.iOS-[A-Za-z0-9._-]{1,128}$/u;
const DEVICE_TYPE = /^com\.apple\.CoreSimulator\.SimDeviceType\.[A-Za-z0-9._-]{1,128}$/u;

export interface SimulatorCreateExecution {
  readonly instance: PublicSimulatorInstance;
  readonly replayed: boolean;
}

export interface SimulatorPendingRecovery {
  readonly markerName: string;
  readonly result: "owned_renamed" | "orphan_deleted" | "absent" | "retained";
}

/** Claims creation, persists the marker, adopts exact ownership, then finishes rename. */
export class SimulatorCreateCoordinator {
  readonly #store: OperationalStore;
  readonly #ownership: SimulatorOwnershipRegistry;
  readonly #pending: SimulatorPendingCreateRegistry;
  readonly #create: SimulatorCreateRuntime;
  readonly #lifecycle: SimulatorLifecycleRuntime;

  constructor(store: OperationalStore, ownership: SimulatorOwnershipRegistry, pending: SimulatorPendingCreateRegistry,
    options: { readonly create?: SimulatorCreateRuntime; readonly lifecycle?: SimulatorLifecycleRuntime } = {}) {
    this.#store = store;
    this.#ownership = ownership;
    this.#pending = pending;
    this.#create = options.create ?? createSimulatorCreateRuntime();
    this.#lifecycle = options.lifecycle ?? createSimulatorLifecycleRuntime();
  }

  async create(scope: SimulatorTaskScope, input: { readonly templateUdid: string; readonly name: string },
    authority: SimulatorLifecycleEffectAuthority, signal?: AbortSignal): Promise<SimulatorCreateExecution> {
    if (!UUID.test(input.templateUdid) || typeof input.name !== "string" || input.name.length < 1
      || input.name.length > 128 || input.name.trim() !== input.name || /[\u0000-\u001f\u007f]/u.test(input.name)) {
      throw new SimulatorCreateError("INVALID_ARGUMENT", "Simulator template or name is invalid.");
    }
    if (!DIGEST.test(authority.effectIdentity) || !BODY_HASH.test(authority.requestBodyHash)
      || !Number.isSafeInteger(authority.providerGeneration) || authority.providerGeneration < 1) {
      throw new SimulatorCreateError("INVALID_ARGUMENT", "Simulator effect authority is unavailable.");
    }
    if (signal?.aborted) throw new SimulatorCreateError("MUTATION_CANCELLED", "Simulator creation was cancelled.");
    this.#ownership.assertScope(scope);
    const operationId = `ios-simulator-create:${authority.effectIdentity}`;
    const claim = this.#store.claimDeferredEffectOperation<PublicSimulatorInstance>({
      id: operationId, kind: KIND,
      body: { sessionId: scope.sessionId, targetId: scope.targetId, bindingGeneration: scope.generation,
        templateUdid: input.templateUdid.toUpperCase(), name: input.name,
        requestBodyHash: authority.requestBodyHash, providerGeneration: authority.providerGeneration }
    }, () => {
      this.#ownership.assertCanCreate(scope);
      if (this.#pending.forSession(scope.sessionId) !== null) {
        throw new OperationInProgressError(operationId);
      }
      let offset = 0;
      for (;;) {
        const page = this.#store.listOperations({ sessionId: scope.sessionId, status: "started", limit: 500, offset });
        const conflicting = page.find(operation =>
          (operation.kind === KIND || operation.kind === "ios_simulator_input" ||
            operation.kind === "ios_simulator_state_control" ||
            operation.kind === "ios_simulator_app_build" ||
            operation.kind === "ios_simulator_app_install" ||
            operation.kind === "ios_simulator_app_control" ||
            operation.kind === "ios_simulator_url_control") &&
          operation.id !== operationId);
        if (conflicting !== undefined) throw new OperationInProgressError(conflicting.id);
        if (page.length < 500) break;
        offset += page.length;
      }
    });
    if (!claim.claimed) return { instance: claim.value, replayed: true };

    let adopted: PublicSimulatorInstance | undefined;
    try {
      const template = await this.#lifecycle.findExact(input.templateUdid, signal);
      if (!template || !template.isAvailable || !IOS_RUNTIME.test(template.runtimeIdentifier)
        || template.deviceTypeIdentifier === null || !DEVICE_TYPE.test(template.deviceTypeIdentifier)) {
        throw new SimulatorCreateError("INVALID_ARGUMENT", "Selected iOS Simulator template is unavailable.");
      }
      const markerName = this.#pending.newMarker();
      const createInput = { markerName, runtimeIdentifier: template.runtimeIdentifier,
        deviceTypeIdentifier: template.deviceTypeIdentifier };
      const evidence = this.#pending.evidence({ ...createInput, sessionId: scope.sessionId, targetId: scope.targetId,
        bindingGeneration: scope.generation, operationId, name: input.name });
      const created = await this.#create.createExact(createInput, evidence, signal);
      this.#pending.markCreated(markerName, created.udid);
      const device = await this.#lifecycle.findExact(created.udid, signal);
      if (!device || device.name !== markerName || device.runtimeIdentifier !== created.runtimeIdentifier
        || device.deviceTypeIdentifier !== created.deviceTypeIdentifier || !device.isAvailable) {
        throw new SimulatorCreateError("SIMULATOR_CREATE_UNKNOWN", "Created Simulator identity could not be confirmed.");
      }
      adopted = this.#ownership.bindCreatedDevice(scope, device, input.name);
      await this.#create.renameExact({ ...created, name: input.name }, signal);
      if (signal?.aborted) throw new SimulatorCreateError("SIMULATOR_RENAME_UNKNOWN", "Simulator rename outcome is unknown.");
      const completed = this.#store.completeDeferredEffectOperation<PublicSimulatorInstance>(
        operationId, claim.operation.bodyHash, () => {
          this.#ownership.assertScope(scope);
          const owned = this.#ownership.createdDeviceByUdid(created.udid, scope.generation);
          if (!owned || owned.instanceId !== adopted!.instanceId) {
            throw new SimulatorOwnershipError("STALE_SCOPE", "Created Simulator ownership changed.");
          }
          this.#pending.clear(markerName);
          return owned;
        }
      );
      return { instance: completed.value, replayed: completed.replayed };
    } catch (error) {
      const safe = error instanceof SimulatorCreateError || error instanceof SimulatorLifecycleError
        || error instanceof SimulatorOwnershipError || error instanceof SimulatorPendingCreateError
        ? error : new SimulatorCreateError("SIMULATOR_CREATE_UNKNOWN", "Simulator creation outcome is unknown.");
      try {
        this.#store.transaction(() => {
          this.#store.failEffectOperation(operationId, claim.operation.bodyHash, safe);
          if (adopted !== undefined) {
            try { this.#ownership.failLifecycle(scope, {
              instanceId: adopted.instanceId, generation: adopted.generation, leaseId: adopted.lease.id
            }, "SIMULATOR_CREATE_RECOVERY_REQUIRED"); }
            catch { /* Pending evidence remains for exact recovery after an owner change. */ }
          }
        });
      } catch { /* Store startup recovery will tombstone an unfinished claim. */ }
      throw safe;
    }
  }

  /** Invoke after Store startup recovery and before admitting another create. */
  async recoverPending(signal?: AbortSignal): Promise<readonly SimulatorPendingRecovery[]> {
    const outcomes: SimulatorPendingRecovery[] = [];
    for (const pending of this.#pending.list()) {
      const operation = this.#store.findOperation(pending.operationId);
      if (operation?.status === "started") {
        outcomes.push({ markerName: pending.markerName, result: "retained" });
        continue;
      }
      try {
        const result = await this.#recoverOne(pending, signal);
        outcomes.push({ markerName: pending.markerName, result });
      } catch {
        outcomes.push({ markerName: pending.markerName, result: "retained" });
      }
    }
    return outcomes;
  }

  async #recoverOne(pending: SimulatorPendingCreateRecord, signal?: AbortSignal): Promise<SimulatorPendingRecovery["result"]> {
    const identity = { markerName: pending.markerName, runtimeIdentifier: pending.runtimeIdentifier,
      deviceTypeIdentifier: pending.deviceTypeIdentifier };
    if (pending.udid !== null) {
      const owned = this.#ownership.createdDeviceByUdid(pending.udid, pending.bindingGeneration);
      if (owned !== null) {
        if (owned.sessionId !== pending.sessionId || owned.targetId !== pending.targetId
          || owned.simulatorName !== pending.name || owned.runtimeIdentifier !== pending.runtimeIdentifier
          || owned.deviceTypeIdentifier !== pending.deviceTypeIdentifier) {
          throw new SimulatorCreateError("SIMULATOR_CREATE_CLEANUP_REQUIRED", "Created Simulator ownership conflicts with pending evidence.");
        }
        await this.#create.renameExact({ ...identity, udid: pending.udid, name: pending.name }, signal);
        this.#store.transaction(() => {
          const current = this.#ownership.createdDeviceByUdid(pending.udid!, pending.bindingGeneration);
          if (!current || current.instanceId !== owned.instanceId || current.sessionId !== pending.sessionId
            || current.targetId !== pending.targetId || current.simulatorName !== pending.name
            || current.runtimeIdentifier !== pending.runtimeIdentifier
            || current.deviceTypeIdentifier !== pending.deviceTypeIdentifier) {
            throw new SimulatorCreateError("SIMULATOR_CREATE_CLEANUP_REQUIRED", "Created Simulator ownership changed during recovery.");
          }
          this.#ownership.restoreCreatedDevice(pending.udid!);
          this.#pending.clear(pending.markerName);
        });
        return "owned_renamed";
      }
    }
    const matching = await this.#create.findPendingMarker(pending.markerName, signal);
    if (matching.length === 0) {
      if (pending.udid !== null && await this.#lifecycle.findExact(pending.udid, signal) !== null) {
        throw new SimulatorCreateError("SIMULATOR_CREATE_CLEANUP_REQUIRED", "Unowned Simulator identity changed.");
      }
      this.#pending.clear(pending.markerName);
      return "absent";
    }
    if (matching.length !== 1 || matching[0]!.runtimeIdentifier !== pending.runtimeIdentifier
      || matching[0]!.deviceTypeIdentifier !== pending.deviceTypeIdentifier
      || pending.udid !== null && matching[0]!.udid.toUpperCase() !== pending.udid) {
      throw new SimulatorCreateError("SIMULATOR_CREATE_CLEANUP_REQUIRED", "Pending Simulator identity changed.");
    }
    if (this.#ownership.deviceByUdid(matching[0]!.udid) !== null) {
      throw new SimulatorCreateError("SIMULATOR_CREATE_CLEANUP_REQUIRED", "Pending Simulator is already owned.");
    }
    await this.#create.deletePendingExact({ ...identity, udid: matching[0]!.udid }, signal);
    this.#pending.clear(pending.markerName);
    return "orphan_deleted";
  }
}
