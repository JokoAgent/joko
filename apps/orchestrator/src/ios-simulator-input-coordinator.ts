import { OperationConflictError, OperationInProgressError, OperationPreviouslyFailedError,
  type OperationalStore } from "@joko/store";
import { SimulatorScreenMapError, WdaClientError,
  type SimulatorScreenMap, type WdaPoint } from "@joko/tool-ios-simulator";
import { SimulatorDriverError, type SimulatorDriverCoordinator } from "./ios-simulator-driver-coordinator.js";
import { SimulatorObservationError, type SimulatorInteractionObservation,
  type SimulatorObserveAfterMode, type SimulatorScreenObservationCoordinator
} from "./ios-simulator-screen-observation.js";
import { SimulatorOwnershipError, type PublicSimulatorInstance, type SimulatorInstanceRoute,
  type SimulatorTaskScope } from "./ios-simulator-ownership.js";
import type { SimulatorLifecycleEffectAuthority } from "./ios-simulator-lifecycle-coordinator.js";

const KIND = "ios_simulator_input";
const DIGEST = /^[0-9a-f]{64}$/u;
const BODY_HASH = /^sha256:[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu;
const CONFLICTING_KINDS = new Set([
  KIND, "ios_simulator_instance_control", "ios_simulator_create", "ios_simulator_lifecycle",
  "ios_simulator_driver", "ios_simulator_grace_cleanup", "ios_simulator_removed_cleanup"
]);

type InputDriver = Pick<SimulatorDriverCoordinator,
  "isReady" | "tap" | "swipe" | "typeText" | "pressHome">;
type InputScreen = Pick<SimulatorScreenObservationCoordinator,
  "requireInteractionSnapshot" | "invalidateInteraction" | "observeAfter">;

export type SimulatorInputAction =
  | { readonly type: "tap"; readonly snapshotId: string;
      readonly target: { readonly elementId: string } | WdaPoint }
  | { readonly type: "swipe"; readonly snapshotId: string; readonly start: WdaPoint;
      readonly end: WdaPoint; readonly durationMs: number }
  | { readonly type: "type_text"; readonly snapshotId: string; readonly text: string }
  | { readonly type: "press_home"; readonly snapshotId: string };

export interface SimulatorInputObserveOptions {
  readonly mode: SimulatorObserveAfterMode;
  readonly timeoutMs: number;
  readonly stableForMs: number;
}

export interface SimulatorInputReceipt {
  readonly action: SimulatorInputAction["type"];
  readonly instanceId: string;
  readonly generation: number;
  readonly backend: "wda";
  readonly completedAt: string;
  readonly observationResult: {
    readonly mode: SimulatorObserveAfterMode;
    readonly state: "not_requested" | "captured" | "timed_out" | "failed";
    readonly reasonCode?: string;
  };
}

export interface SimulatorInputExecution {
  readonly receipt: SimulatorInputReceipt;
  readonly replayed: boolean;
  readonly observation: SimulatorInteractionObservation | null;
  readonly observationError: { readonly code: string; readonly message: string } | null;
}

export class SimulatorInputError extends Error {
  constructor(readonly code: "INVALID_ARGUMENT" | "MUTATION_CANCELLED" |
    "MUTATION_IN_PROGRESS" | "MUTATION_CONFLICT" | "INPUT_OUTCOME_UNKNOWN",
    message: string) { super(message); }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validPoint(value: WdaPoint): boolean {
  return value !== null && typeof value === "object" && typeof value.x === "number" &&
    Number.isFinite(value.x) && value.x >= 0 && value.x <= 1_000_000 &&
    typeof value.y === "number" && Number.isFinite(value.y) && value.y >= 0 && value.y <= 1_000_000;
}

function elementPoint(screenMap: SimulatorScreenMap, elementId: string): WdaPoint {
  const element = screenMap.elements.find(candidate => candidate.elementId === elementId);
  if (!element?.frame || element.enabled === false || element.visible === false ||
      element.frame.width <= 0 || element.frame.height <= 0) {
    throw new SimulatorObservationError("STALE_UI_SNAPSHOT",
      "The Simulator target is no longer interactable. Read a new screen map.");
  }
  const point = { x: element.frame.x + element.frame.width / 2,
    y: element.frame.y + element.frame.height / 2 };
  if (!validPoint(point)) {
    throw new SimulatorObservationError("STALE_UI_SNAPSHOT",
      "The Simulator target is no longer interactable. Read a new screen map.");
  }
  return point;
}

function priorFailure(error: OperationPreviouslyFailedError): SimulatorInputError {
  const stored = error.storedError;
  const code = isRecord(stored) && typeof stored["code"] === "string" ? stored["code"] : null;
  if (code === "MUTATION_CANCELLED") {
    return new SimulatorInputError("MUTATION_CANCELLED", "Simulator input was already cancelled.");
  }
  if (code === "MUTATION_IN_PROGRESS") {
    return new SimulatorInputError("MUTATION_IN_PROGRESS", "Simulator input was already blocked by another operation.");
  }
  return new SimulatorInputError("INPUT_OUTCOME_UNKNOWN",
    "This Simulator input previously failed and will not be dispatched again.");
}

/** Durable public-input boundary. Raw typed text is deliberately excluded from Operation bodies. */
export class SimulatorInputCoordinator {
  readonly #store: OperationalStore;
  readonly #ownership: { requireRoute(scope: SimulatorTaskScope, route: SimulatorInstanceRoute): PublicSimulatorInstance };
  readonly #driver: InputDriver;
  readonly #screen: InputScreen;
  readonly #now: () => number;

  constructor(store: OperationalStore,
    ownership: { requireRoute(scope: SimulatorTaskScope, route: SimulatorInstanceRoute): PublicSimulatorInstance },
    driver: InputDriver, screen: InputScreen, options: { readonly now?: () => number } = {}) {
    this.#store = store;
    this.#ownership = ownership;
    this.#driver = driver;
    this.#screen = screen;
    this.#now = options.now ?? Date.now;
  }

  async execute(scope: SimulatorTaskScope, route: SimulatorInstanceRoute, action: SimulatorInputAction,
    observe: SimulatorInputObserveOptions, authority: SimulatorLifecycleEffectAuthority,
    signal?: AbortSignal): Promise<SimulatorInputExecution> {
    this.#validate(action, observe, authority);
    if (signal?.aborted) {
      throw new SimulatorInputError("MUTATION_CANCELLED", "Simulator input was cancelled before admission.");
    }
    const operationId = `ios-simulator-input:${authority.effectIdentity}`;
    let instance: PublicSimulatorInstance | undefined;
    let resolvedAction: SimulatorInputAction = action;
    let claim;
    try {
      claim = this.#store.claimDeferredEffectOperation<SimulatorInputReceipt>({ id: operationId, kind: KIND,
        body: { action: action.type, sessionId: scope.sessionId, targetId: scope.targetId,
          bindingGeneration: scope.generation, instanceId: route.instanceId,
          instanceGeneration: route.generation, leaseId: route.leaseId,
          snapshotId: action.snapshotId, requestBodyHash: authority.requestBodyHash,
          providerGeneration: authority.providerGeneration }
      }, () => {
        instance = this.#ownership.requireRoute(scope, route);
        if (instance.lifecycleState !== "ready" || instance.viewerState !== "attached" ||
            !this.#driver.isReady(instance)) {
          throw new SimulatorDriverError("DRIVER_RUNTIME_LOST", "Simulator driver is not ready for input.");
        }
        const snapshot = this.#screen.requireInteractionSnapshot(scope, route, action.snapshotId);
        if (action.type === "tap" && "elementId" in action.target) {
          resolvedAction = { ...action, target: elementPoint(snapshot, action.target.elementId) };
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
        throw new SimulatorInputError("MUTATION_CONFLICT",
          "Simulator input identity was already used with different arguments.");
      }
      if (error instanceof OperationInProgressError) {
        throw new SimulatorInputError("MUTATION_IN_PROGRESS", "Another Simulator operation is in progress.");
      }
      throw error;
    }
    if (!claim.claimed) {
      this.#ownership.requireRoute(scope, route);
      return { receipt: claim.value, replayed: true, observation: null, observationError: null };
    }
    if (!instance) throw new Error("Simulator input admission did not resolve its instance.");
    let dispatched = false;
    try {
      this.#screen.invalidateInteraction(scope, route, action.snapshotId);
      dispatched = true;
      await this.#dispatch(instance, resolvedAction, signal);
      let observation: SimulatorInteractionObservation | null = null;
      let observationError: SimulatorInputExecution["observationError"] = null;
      try {
        observation = await this.#screen.observeAfter(scope, route, observe.mode, {
          timeoutMs: observe.timeoutMs, stableForMs: observe.stableForMs
        }, signal);
      } catch (error) {
        observationError = this.#observationFailure(error, signal);
      }
      const observationResult: SimulatorInputReceipt["observationResult"] = observationError
        ? { mode: observe.mode, state: "failed", reasonCode: observationError.code }
        : observation?.timedOut ? { mode: observe.mode, state: "timed_out" }
          : observation ? { mode: observe.mode, state: "captured" }
            : { mode: observe.mode, state: "not_requested" };
      const completed = this.#store.completeDeferredEffectOperation<SimulatorInputReceipt>(operationId,
        claim.operation.bodyHash, () => ({ action: action.type, instanceId: instance!.instanceId,
          generation: instance!.generation, backend: "wda", completedAt: new Date(this.#now()).toISOString(),
          observationResult }));
      return { receipt: completed.value, replayed: completed.replayed,
        observation: completed.replayed ? null : observation,
        observationError: completed.replayed ? null : observationError };
    } catch (error) {
      const safe = this.#inputFailure(error, dispatched, signal);
      try { this.#store.failEffectOperation(operationId, claim.operation.bodyHash, safe); }
      catch { /* Store startup recovery fences a still-started input effect. */ }
      throw safe;
    }
  }

  #validate(action: SimulatorInputAction, observe: SimulatorInputObserveOptions,
    authority: SimulatorLifecycleEffectAuthority): void {
    if (!DIGEST.test(authority.effectIdentity) || !BODY_HASH.test(authority.requestBodyHash) ||
        !Number.isSafeInteger(authority.providerGeneration) || authority.providerGeneration < 1 ||
        !UUID.test(action.snapshotId)) {
      throw new SimulatorInputError("INVALID_ARGUMENT", "Simulator input authority or snapshot is invalid.");
    }
    if (observe.mode !== "none" && observe.mode !== "immediate" && observe.mode !== "stable" ||
        !Number.isSafeInteger(observe.timeoutMs) || observe.timeoutMs < 100 || observe.timeoutMs > 15_000 ||
        !Number.isSafeInteger(observe.stableForMs) || observe.stableForMs < 100 || observe.stableForMs > 2_000) {
      throw new SimulatorInputError("INVALID_ARGUMENT", "Simulator post-input observation bounds are invalid.");
    }
    if (action.type === "tap") {
      if ("elementId" in action.target) {
        if (typeof action.target.elementId !== "string" || action.target.elementId.length < 1 ||
            action.target.elementId.length > 128 || action.target.elementId.trim() !== action.target.elementId) {
          throw new SimulatorInputError("INVALID_ARGUMENT", "Simulator element identity is invalid.");
        }
      } else if (!validPoint(action.target)) {
        throw new SimulatorInputError("INVALID_ARGUMENT", "Simulator tap coordinates are invalid.");
      }
    } else if (action.type === "swipe") {
      if (!validPoint(action.start) || !validPoint(action.end) || !Number.isSafeInteger(action.durationMs) ||
          action.durationMs < 50 || action.durationMs > 60_000) {
        throw new SimulatorInputError("INVALID_ARGUMENT", "Simulator swipe arguments are invalid.");
      }
    } else if (action.type === "type_text") {
      if (typeof action.text !== "string" || action.text.length > 10_000) {
        throw new SimulatorInputError("INVALID_ARGUMENT", "Simulator text input exceeds its limit.");
      }
    } else if (action.type !== "press_home") {
      throw new SimulatorInputError("INVALID_ARGUMENT", "Simulator input action is invalid.");
    }
  }

  async #dispatch(instance: PublicSimulatorInstance, action: SimulatorInputAction,
    signal?: AbortSignal): Promise<void> {
    if (action.type === "tap") {
      if ("elementId" in action.target) throw new Error("Simulator element target was not resolved.");
      await this.#driver.tap(instance, action.target, signal);
    } else if (action.type === "swipe") {
      await this.#driver.swipe(instance, action.start, action.end, action.durationMs, signal);
    } else if (action.type === "type_text") {
      await this.#driver.typeText(instance, action.text, signal);
    } else {
      await this.#driver.pressHome(instance, signal);
    }
  }

  #inputFailure(error: unknown, dispatched: boolean, signal?: AbortSignal): Error {
    if (error instanceof SimulatorInputError || error instanceof SimulatorObservationError ||
        error instanceof SimulatorScreenMapError || error instanceof SimulatorOwnershipError) return error;
    if (error instanceof WdaClientError) {
      if (error.code === "INPUT_OUTCOME_UNKNOWN") {
        return new SimulatorInputError("INPUT_OUTCOME_UNKNOWN",
          "Simulator input outcome is unknown; read a new screen map before another action.");
      }
      if (error.code === "CANCELLED") {
        return new SimulatorInputError("MUTATION_CANCELLED", "Simulator input was cancelled before dispatch.");
      }
      return error;
    }
    if (error instanceof SimulatorDriverError) {
      if (error.code === "INPUT_OUTCOME_UNKNOWN") {
        return new SimulatorInputError("INPUT_OUTCOME_UNKNOWN",
          "Simulator input outcome is unknown; read a new screen map before another action.");
      }
      return error;
    }
    if (signal?.aborted && !dispatched) {
      return new SimulatorInputError("MUTATION_CANCELLED", "Simulator input was cancelled before dispatch.");
    }
    return new SimulatorInputError("INPUT_OUTCOME_UNKNOWN",
      "Simulator input outcome is unknown; read a new screen map before another action.");
  }

  #observationFailure(error: unknown, signal?: AbortSignal): { readonly code: string; readonly message: string } {
    if (error instanceof SimulatorObservationError || error instanceof SimulatorDriverError ||
        error instanceof SimulatorOwnershipError || error instanceof WdaClientError) {
      return { code: error.code, message: error.message };
    }
    if (signal?.aborted) {
      return { code: "OBSERVATION_CANCELLED", message: "Post-input Simulator observation was cancelled." };
    }
    return { code: "OBSERVATION_FAILED", message: "Post-input Simulator observation failed." };
  }
}
