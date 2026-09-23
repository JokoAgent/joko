import { createSimulatorLifecycleRuntime, SimulatorLifecycleError, type SimulatorLifecycleRuntime } from "@joko/tool-ios-simulator";
import { OperationInProgressError, type OperationalStore } from "@joko/store";
import {
  SimulatorOwnershipRegistry, type PublicSimulatorInstance, type SimulatorInstanceRoute, type SimulatorTaskScope
} from "./ios-simulator-ownership.js";

const KIND = "ios_simulator_lifecycle";
const DIGEST = /^[0-9a-f]{64}$/u;
const BODY_HASH = /^sha256:[0-9a-f]{64}$/u;

/** Authenticated native request identity supplied by the Tool Bridge, never by tool arguments. */
export interface SimulatorLifecycleEffectAuthority {
  readonly effectIdentity: string;
  readonly requestBodyHash: string;
  readonly providerGeneration: number;
}

export interface SimulatorLifecycleExecution {
  readonly instance: PublicSimulatorInstance;
  readonly replayed: boolean;
}

/** Durable admission precedes every simctl mutation; unknown outcomes are never replayed. */
export class SimulatorLifecycleCoordinator {
  readonly #store: OperationalStore;
  readonly #ownership: SimulatorOwnershipRegistry;
  readonly #runtime: SimulatorLifecycleRuntime;

  constructor(store: OperationalStore, ownership: SimulatorOwnershipRegistry,
    runtime: SimulatorLifecycleRuntime = createSimulatorLifecycleRuntime()) {
    this.#store = store;
    this.#ownership = ownership;
    this.#runtime = runtime;
  }

  start(scope: SimulatorTaskScope, route: SimulatorInstanceRoute, authority: SimulatorLifecycleEffectAuthority,
    signal?: AbortSignal): Promise<SimulatorLifecycleExecution> {
    return this.#execute("start", scope, route, authority, signal);
  }

  stop(scope: SimulatorTaskScope, route: SimulatorInstanceRoute, authority: SimulatorLifecycleEffectAuthority,
    signal?: AbortSignal): Promise<SimulatorLifecycleExecution> {
    return this.#execute("stop", scope, route, authority, signal);
  }

  async #execute(action: "start" | "stop", scope: SimulatorTaskScope, route: SimulatorInstanceRoute,
    authority: SimulatorLifecycleEffectAuthority, signal?: AbortSignal): Promise<SimulatorLifecycleExecution> {
    if (!DIGEST.test(authority.effectIdentity) || !BODY_HASH.test(authority.requestBodyHash)
      || !Number.isSafeInteger(authority.providerGeneration) || authority.providerGeneration < 1) {
      throw new SimulatorLifecycleError("INVALID_ARGUMENT", "Simulator effect authority is unavailable.");
    }
    if (signal?.aborted) throw new SimulatorLifecycleError("MUTATION_CANCELLED", "Simulator operation was cancelled.");
    this.#ownership.reconcileRecoveredEffects(scope);
    this.#ownership.assertScope(scope);
    const operationId = `ios-simulator-lifecycle:${authority.effectIdentity}`;
    let owned: PublicSimulatorInstance | undefined;
    const claim = this.#store.claimDeferredEffectOperation<PublicSimulatorInstance>({
      id: operationId,
      kind: KIND,
      body: {
        action, sessionId: scope.sessionId, targetId: scope.targetId, bindingGeneration: scope.generation,
        instanceId: route.instanceId, instanceGeneration: route.generation, leaseId: route.leaseId,
        requestBodyHash: authority.requestBodyHash,
        providerGeneration: authority.providerGeneration
      }
    }, () => {
      owned = this.#ownership.requireRoute(scope, route);
      // The active operation is visible in this transaction. A different request may not
      // race the same device even if it arrived with a distinct native request identity.
      let offset = 0;
      for (;;) {
        const page = this.#store.listOperations({ sessionId: scope.sessionId, status: "started", limit: 500, offset });
        const conflicting = page.find(operation => operation.kind === KIND && operation.id !== operationId);
        if (conflicting !== undefined) throw new OperationInProgressError(conflicting.id);
        if (page.length < 500) break;
        offset += page.length;
      }
    });
    if (!claim.claimed) return { instance: claim.value, replayed: true };
    if (owned === undefined) throw new Error("Simulator effect admission did not resolve its instance.");

    try {
      const before = await this.#runtime.findExact(owned.simulatorUdid, signal);
      if (before === null) throw new SimulatorLifecycleError("SIMULATOR_NOT_FOUND", "Selected Simulator device no longer exists.");
      if (action === "start") await this.#runtime.bootExact(owned.simulatorUdid, signal);
      else await this.#runtime.shutdownExact(owned.simulatorUdid, signal);
      const observed = await this.#runtime.findExact(owned.simulatorUdid, signal);
      if (signal?.aborted || observed?.udid.toUpperCase() !== owned.simulatorUdid
        || observed.state.toLowerCase() !== (action === "start" ? "booted" : "shutdown")) {
        throw new SimulatorLifecycleError(action === "start" ? "SIMULATOR_BOOT_UNKNOWN" : "SIMULATOR_SHUTDOWN_UNKNOWN",
          "Simulator command outcome is unknown; refresh device state before retrying.");
      }
      const completed = this.#store.completeDeferredEffectOperation<PublicSimulatorInstance>(
        operationId, claim.operation.bodyHash,
        () => this.#ownership.completeLifecycle(scope, route, {
          action, bootedByAgent: action === "start" && before.state.toLowerCase() === "shutdown"
        })
      );
      return { instance: completed.value, replayed: completed.replayed };
    } catch (error) {
      const safe = error instanceof SimulatorLifecycleError ? error : new SimulatorLifecycleError(
        action === "start" ? "SIMULATOR_BOOT_UNKNOWN" : "SIMULATOR_SHUTDOWN_UNKNOWN",
        "Simulator command outcome is unknown; refresh device state before retrying."
      );
      try {
        this.#store.transaction(() => {
          this.#store.failEffectOperation(operationId, claim.operation.bodyHash, safe);
          try { this.#ownership.failLifecycle(scope, route, safe.code); }
          catch { /* The original owner may have changed while simctl was running. */ }
        });
      } catch { /* Startup recovery will tombstone a still-started effect. */ }
      throw safe;
    }
  }
}
