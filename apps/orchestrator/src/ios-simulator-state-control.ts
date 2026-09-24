import { OperationConflictError, OperationInProgressError, OperationPreviouslyFailedError,
  type OperationalStore } from "@joko/store";
import { JokoError } from "@joko/core";
import { createSimulatorLifecycleRuntime, SimulatorLifecycleError, SimulatorScreenMapError,
  WdaClientError, type SimulatorAppearance, type SimulatorContentSize,
  type SimulatorLifecycleRuntime, type WdaViewport } from "@joko/tool-ios-simulator";
import { SimulatorDriverError, type SimulatorDriverCoordinator } from "./ios-simulator-driver-coordinator.js";
import { SimulatorObservationError,
  type SimulatorScreenObservationCoordinator } from "./ios-simulator-screen-observation.js";
import { SimulatorOwnershipError, type PublicSimulatorInstance, type SimulatorInstanceRoute,
  type SimulatorTaskScope } from "./ios-simulator-ownership.js";
import type { SimulatorLifecycleEffectAuthority } from "./ios-simulator-lifecycle-coordinator.js";

const KIND = "ios_simulator_state_control";
const DIGEST = /^[0-9a-f]{64}$/u;
const BODY_HASH = /^sha256:[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu;
const CONTENT_SIZES = new Set<SimulatorContentSize>([
  "extra-small", "small", "medium", "large", "extra-large", "extra-extra-large",
  "extra-extra-extra-large", "accessibility-medium", "accessibility-large",
  "accessibility-extra-large", "accessibility-extra-extra-large",
  "accessibility-extra-extra-extra-large"
]);
const CONFLICTING_KINDS = new Set([
  KIND, "ios_simulator_instance_control", "ios_simulator_create", "ios_simulator_lifecycle",
  "ios_simulator_driver", "ios_simulator_input", "ios_simulator_grace_cleanup",
  "ios_simulator_removed_cleanup"
]);

type StateDriver = Pick<SimulatorDriverCoordinator, "isReady" | "setOrientation">;
type StateScreen = Pick<SimulatorScreenObservationCoordinator,
  "requireInteractionSnapshot" | "invalidateInteraction" | "invalidateRoute">;
type StateLifecycle = Pick<SimulatorLifecycleRuntime,
  "setAppearance" | "setIncreaseContrast" | "setContentSize">;

export type SimulatorStateControlAction =
  | { readonly type: "set_orientation"; readonly snapshotId: string;
      readonly orientation: WdaViewport["orientation"] }
  | { readonly type: "set_appearance"; readonly appearance: SimulatorAppearance }
  | { readonly type: "set_increase_contrast"; readonly enabled: boolean }
  | { readonly type: "set_content_size"; readonly contentSize: SimulatorContentSize };

export interface SimulatorStateControlReceipt {
  readonly interaction: SimulatorStateControlAction["type"];
  readonly instanceId: string;
  readonly generation: number;
  readonly backend: "wda" | "simctl";
  readonly completedAt: string;
  readonly orientation?: WdaViewport["orientation"];
  readonly mode?: "device";
  readonly viewport?: WdaViewport;
  readonly appearance?: SimulatorAppearance;
  readonly enabled?: boolean;
  readonly contentSize?: SimulatorContentSize;
}

export interface SimulatorStateControlExecution {
  readonly receipt: SimulatorStateControlReceipt;
  readonly replayed: boolean;
}

export class SimulatorStateControlError extends JokoError {
  constructor(readonly code: string, message: string) {
    super({ code, message, phase: "simulator_state_control", retryable: false,
      stateMayHaveChanged: code === "STATE_OUTCOME_UNKNOWN",
      recovery: code === "STATE_OUTCOME_UNKNOWN"
        ? "Read current Simulator state before issuing another control."
        : "Correct the request or inspect the current Simulator state." });
    this.name = "SimulatorStateControlError";
  }
}

function priorFailure(error: OperationPreviouslyFailedError): SimulatorStateControlError {
  const stored = error.storedError;
  const code = stored && typeof stored === "object" && !Array.isArray(stored) &&
    typeof (stored as Record<string, unknown>)["code"] === "string"
    ? String((stored as Record<string, unknown>)["code"]) : "STATE_OUTCOME_UNKNOWN";
  if (code === "MUTATION_CANCELLED") {
    return new SimulatorStateControlError(code, "Simulator state control was already cancelled.");
  }
  if (code === "ORIENTATION_UNSUPPORTED" || code === "SIMULATOR_CONTROL_FAILED") {
    return new SimulatorStateControlError(code, "This Simulator state control previously failed.");
  }
  return new SimulatorStateControlError("STATE_OUTCOME_UNKNOWN",
    "This Simulator state control previously failed and will not be dispatched again.");
}

/** Durable boundary for device presentation and accessibility state mutations. */
export class SimulatorStateControlCoordinator {
  readonly #store: OperationalStore;
  readonly #ownership: { requireRoute(scope: SimulatorTaskScope,
    route: SimulatorInstanceRoute): PublicSimulatorInstance };
  readonly #driver: StateDriver;
  readonly #screen: StateScreen;
  readonly #lifecycle: StateLifecycle;
  readonly #now: () => number;

  constructor(store: OperationalStore,
    ownership: { requireRoute(scope: SimulatorTaskScope,
      route: SimulatorInstanceRoute): PublicSimulatorInstance },
    driver: StateDriver, screen: StateScreen,
    lifecycle: StateLifecycle = createSimulatorLifecycleRuntime(),
    options: { readonly now?: () => number } = {}) {
    this.#store = store;
    this.#ownership = ownership;
    this.#driver = driver;
    this.#screen = screen;
    this.#lifecycle = lifecycle;
    this.#now = options.now ?? Date.now;
  }

  async execute(scope: SimulatorTaskScope, route: SimulatorInstanceRoute,
    action: SimulatorStateControlAction, authority: SimulatorLifecycleEffectAuthority,
    signal?: AbortSignal): Promise<SimulatorStateControlExecution> {
    this.#validate(action, authority);
    if (signal?.aborted) {
      throw new SimulatorStateControlError("MUTATION_CANCELLED",
        "Simulator state control was cancelled before admission.");
    }
    const operationId = `${KIND}:${authority.effectIdentity}`;
    let instance: PublicSimulatorInstance | undefined;
    let claim;
    try {
      claim = this.#store.claimDeferredEffectOperation<SimulatorStateControlReceipt>({
        id: operationId, kind: KIND,
        body: { action: action.type, sessionId: scope.sessionId, targetId: scope.targetId,
          bindingGeneration: scope.generation, instanceId: route.instanceId,
          instanceGeneration: route.generation, leaseId: route.leaseId,
          ...(action.type === "set_orientation" ? { snapshotId: action.snapshotId } : {}),
          requestBodyHash: authority.requestBodyHash,
          providerGeneration: authority.providerGeneration }
      }, () => {
        instance = this.#ownership.requireRoute(scope, route);
        if (instance.lifecycleState !== "ready" || instance.viewerState !== "attached" ||
            !this.#driver.isReady(instance)) {
          throw new SimulatorDriverError("DRIVER_RUNTIME_LOST",
            "Simulator driver is not ready for state control.");
        }
        if (action.type === "set_orientation") {
          this.#screen.requireInteractionSnapshot(scope, route, action.snapshotId);
        } else if (action.type === "set_appearance" && !this.#lifecycle.setAppearance ||
            action.type === "set_increase_contrast" && !this.#lifecycle.setIncreaseContrast ||
            action.type === "set_content_size" && !this.#lifecycle.setContentSize) {
          throw new SimulatorStateControlError("CONTROL_UNAVAILABLE",
            "Simulator system setting control is unavailable.");
        }
        let offset = 0;
        for (;;) {
          const page = this.#store.listOperations({ sessionId: scope.sessionId,
            status: "started", limit: 500, offset });
          const conflict = page.find(operation => operation.id !== operationId &&
            CONFLICTING_KINDS.has(operation.kind));
          if (conflict) throw new OperationInProgressError(conflict.id);
          if (page.length < 500) break;
          offset += page.length;
        }
      });
    } catch (error) {
      if (error instanceof OperationPreviouslyFailedError) throw priorFailure(error);
      if (error instanceof OperationConflictError) {
        throw new SimulatorStateControlError("MUTATION_CONFLICT",
          "Simulator state control identity was already used with different arguments.");
      }
      if (error instanceof OperationInProgressError) {
        throw new SimulatorStateControlError("MUTATION_IN_PROGRESS",
          "Another Simulator operation is in progress.");
      }
      throw error;
    }
    if (!claim.claimed) {
      this.#ownership.requireRoute(scope, route);
      return { receipt: claim.value, replayed: true };
    }
    if (!instance) throw new Error("Simulator state-control admission did not resolve its instance.");

    let attempted = false;
    try {
      let result: Omit<SimulatorStateControlReceipt, "interaction" | "instanceId" |
        "generation" | "completedAt">;
      if (action.type === "set_orientation") {
        this.#screen.invalidateInteraction(scope, route, action.snapshotId);
        attempted = true;
        const viewport = await this.#driver.setOrientation(instance, action.orientation, signal);
        result = { backend: "wda", orientation: action.orientation, mode: "device", viewport };
      } else if (action.type === "set_appearance") {
        attempted = true;
        await this.#lifecycle.setAppearance!(instance.simulatorUdid, action.appearance, signal);
        result = { backend: "simctl", appearance: action.appearance };
      } else if (action.type === "set_increase_contrast") {
        attempted = true;
        await this.#lifecycle.setIncreaseContrast!(instance.simulatorUdid, action.enabled, signal);
        result = { backend: "simctl", enabled: action.enabled };
      } else {
        attempted = true;
        await this.#lifecycle.setContentSize!(instance.simulatorUdid, action.contentSize, signal);
        result = { backend: "simctl", contentSize: action.contentSize };
      }
      const current = this.#ownership.requireRoute(scope, route);
      if (!this.#driver.isReady(current)) {
        throw new SimulatorDriverError("DRIVER_RUNTIME_LOST",
          "Simulator driver changed during state control.");
      }
      if (action.type !== "set_orientation") this.#screen.invalidateRoute(scope, route);
      const completed = this.#store.completeDeferredEffectOperation<SimulatorStateControlReceipt>(
        operationId, claim.operation.bodyHash, () => ({ interaction: action.type,
          instanceId: current.instanceId, generation: current.generation,
          completedAt: new Date(this.#now()).toISOString(), ...result }));
      return { receipt: completed.value, replayed: completed.replayed };
    } catch (error) {
      const safe = this.#failure(error, attempted, signal);
      try { this.#store.failEffectOperation(operationId, claim.operation.bodyHash, safe); }
      catch { /* Store startup recovery fences a still-started state-control effect. */ }
      throw safe;
    }
  }

  #validate(action: SimulatorStateControlAction,
    authority: SimulatorLifecycleEffectAuthority): void {
    if (!DIGEST.test(authority.effectIdentity) || !BODY_HASH.test(authority.requestBodyHash) ||
        !Number.isSafeInteger(authority.providerGeneration) || authority.providerGeneration < 1) {
      throw new SimulatorStateControlError("INVALID_ARGUMENT",
        "Simulator state-control authority is unavailable.");
    }
    if (action.type === "set_orientation") {
      if (!UUID.test(action.snapshotId) ||
          action.orientation !== "PORTRAIT" && action.orientation !== "LANDSCAPE") {
        throw new SimulatorStateControlError("INVALID_ARGUMENT",
          "Simulator orientation arguments are invalid.");
      }
    } else if (action.type === "set_appearance") {
      if (action.appearance !== "light" && action.appearance !== "dark") {
        throw new SimulatorStateControlError("INVALID_ARGUMENT", "Simulator appearance is invalid.");
      }
    } else if (action.type === "set_increase_contrast") {
      if (typeof action.enabled !== "boolean") {
        throw new SimulatorStateControlError("INVALID_ARGUMENT", "Simulator contrast setting is invalid.");
      }
    } else if (action.type === "set_content_size") {
      if (!CONTENT_SIZES.has(action.contentSize)) {
        throw new SimulatorStateControlError("INVALID_ARGUMENT", "Simulator content size is invalid.");
      }
    } else {
      throw new SimulatorStateControlError("INVALID_ARGUMENT", "Simulator state control is invalid.");
    }
  }

  #failure(error: unknown, attempted: boolean, signal?: AbortSignal): Error {
    if (error instanceof WdaClientError && error.code === "ORIENTATION_UNSUPPORTED") {
      return new SimulatorStateControlError("ORIENTATION_UNSUPPORTED", error.message);
    }
    if (error instanceof SimulatorLifecycleError && error.code === "SIMULATOR_CONTROL_FAILED") {
      return new SimulatorStateControlError(error.code, error.message);
    }
    if (!attempted && (error instanceof SimulatorStateControlError ||
        error instanceof SimulatorObservationError || error instanceof SimulatorScreenMapError ||
        error instanceof SimulatorOwnershipError || error instanceof SimulatorDriverError ||
        error instanceof SimulatorLifecycleError)) return error;
    if (signal?.aborted && !attempted) {
      return new SimulatorStateControlError("MUTATION_CANCELLED",
        "Simulator state control was cancelled before dispatch.");
    }
    return new SimulatorStateControlError("STATE_OUTCOME_UNKNOWN",
      "Simulator state-control outcome is unknown; read current state before retrying.");
  }
}
