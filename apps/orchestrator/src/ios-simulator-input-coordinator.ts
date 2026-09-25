import { OperationConflictError, OperationInProgressError, OperationPreviouslyFailedError,
  type OperationalStore } from "@joko/store";
import { normalizeSimulatorTouchPair, normalizeSimulatorTouchPath, SimulatorNativeHidError,
  SimulatorNativeTouchError, SimulatorScreenMapError, WdaClientError,
  type SimulatorScreenMap, type SimulatorTouchEdge, type WdaPoint } from "@joko/tool-ios-simulator";
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
  "ios_simulator_driver", "ios_simulator_state_control", "ios_simulator_app_build",
  "ios_simulator_app_install", "ios_simulator_app_control", "ios_simulator_url_control",
  "ios_simulator_screenshot", "ios_simulator_visual_capture", "ios_simulator_recording",
  "ios_simulator_grace_cleanup",
  "ios_simulator_removed_cleanup"
]);
const WEB_DRIVER_KEYS = Object.freeze({
  return: "\uE007", tab: "\uE004", escape: "\uE00C", delete: "\uE017",
  arrow_up: "\uE013", arrow_down: "\uE015", arrow_left: "\uE012", arrow_right: "\uE014"
} as const);

type InputDriver = Pick<SimulatorDriverCoordinator,
  "isReady" | "tap" | "swipe" | "typeText" | "pressHome" |
  "observeViewport" | "probeNativeInput" | "touchNativePath">;
type InputScreen = Pick<SimulatorScreenObservationCoordinator,
  "requireInteractionSnapshot" | "invalidateInteraction" | "observeAfter">;

export type SimulatorInputKey = keyof typeof WEB_DRIVER_KEYS;
export type SimulatorBatchAction =
  | { readonly type: "tap"; readonly elementId: string }
  | { readonly type: "swipe"; readonly start: WdaPoint; readonly end: WdaPoint;
      readonly durationMs: number }
  | { readonly type: "drag"; readonly fromElementId: string; readonly toElementId: string;
      readonly durationMs: number }
  | { readonly type: "long_press"; readonly elementId: string; readonly durationMs: number }
  | { readonly type: "type_text"; readonly text: string }
  | { readonly type: "key_press"; readonly key: SimulatorInputKey };

export type SimulatorInputAction =
  | { readonly type: "tap"; readonly snapshotId: string;
      readonly target: { readonly elementId: string } | WdaPoint }
  | { readonly type: "swipe"; readonly snapshotId: string; readonly start: WdaPoint;
      readonly end: WdaPoint; readonly durationMs: number }
  | { readonly type: "drag"; readonly snapshotId: string; readonly fromElementId: string;
      readonly toElementId: string; readonly durationMs: number }
  | { readonly type: "long_press"; readonly snapshotId: string; readonly elementId: string;
      readonly durationMs: number }
  | { readonly type: "key_press"; readonly snapshotId: string; readonly key: SimulatorInputKey }
  | { readonly type: "batch"; readonly snapshotId: string;
      readonly actions: readonly SimulatorBatchAction[] }
  | { readonly type: "type_text"; readonly snapshotId: string; readonly text: string }
  | { readonly type: "touch_path"; readonly snapshotId: string;
      readonly points: unknown; readonly edge: SimulatorTouchEdge }
  | { readonly type: "touch2_path"; readonly snapshotId: string;
      readonly first: unknown; readonly second: unknown }
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
  readonly backend: "wda" | "native-hid";
  readonly completedAt: string;
  readonly observationResult: {
    readonly mode: SimulatorObserveAfterMode;
    readonly state: "not_requested" | "captured" | "timed_out" | "failed";
    readonly reasonCode?: string;
  };
  readonly completed?: readonly { readonly index: number;
    readonly type: SimulatorBatchAction["type"]; readonly backend: "wda" }[];
}

export interface SimulatorInputExecution {
  readonly receipt: SimulatorInputReceipt;
  readonly replayed: boolean;
  readonly observation: SimulatorInteractionObservation | null;
  readonly observationError: { readonly code: string; readonly message: string } | null;
}

export interface SimulatorInputExecutionOptions {
  /** UI requests already bind their full semantic input in requestBodyHash. */
  readonly bindSnapshotToOperation?: boolean;
}

export class SimulatorInputError extends Error {
  constructor(readonly code: "INVALID_ARGUMENT" | "MUTATION_CANCELLED" |
    "MUTATION_IN_PROGRESS" | "MUTATION_CONFLICT" | "INPUT_OUTCOME_UNKNOWN" |
    "NATIVE_INPUT_UNAVAILABLE",
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

function validElementId(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 128 &&
    value.trim() === value;
}

function validText(value: unknown): value is string {
  return typeof value === "string" && value.length <= 10_000;
}

function validKey(value: unknown): value is SimulatorInputKey {
  return typeof value === "string" && Object.hasOwn(WEB_DRIVER_KEYS, value);
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

  async nativeInputAvailable(instances: readonly PublicSimulatorInstance[], signal?: AbortSignal): Promise<boolean> {
    for (const instance of instances) {
      if (instance.lifecycleState !== "ready" || instance.viewerState !== "attached" ||
          !this.#driver.isReady(instance)) continue;
      try {
        if (await this.#driver.probeNativeInput(instance, signal)) return true;
      } catch { /* A stale or unavailable helper is not advertised as ready. */ }
    }
    return false;
  }

  async execute(scope: SimulatorTaskScope, route: SimulatorInstanceRoute, action: SimulatorInputAction,
    observe: SimulatorInputObserveOptions, authority: SimulatorLifecycleEffectAuthority,
    signal?: AbortSignal, options: SimulatorInputExecutionOptions = {}): Promise<SimulatorInputExecution> {
    this.#validate(action, observe, authority);
    if (signal?.aborted) {
      throw new SimulatorInputError("MUTATION_CANCELLED", "Simulator input was cancelled before admission.");
    }
    const operationId = `ios-simulator-input:${authority.effectIdentity}`;
    let instance: PublicSimulatorInstance | undefined;
    let admittedSnapshot: SimulatorScreenMap | undefined;
    let claim;
    try {
      claim = this.#store.claimDeferredEffectOperation<SimulatorInputReceipt>({ id: operationId, kind: KIND,
        body: { action: action.type, sessionId: scope.sessionId, targetId: scope.targetId,
          bindingGeneration: scope.generation, instanceId: route.instanceId,
          instanceGeneration: route.generation, leaseId: route.leaseId,
          ...(options.bindSnapshotToOperation === false ? {} : { snapshotId: action.snapshotId }),
          requestBodyHash: authority.requestBodyHash,
          providerGeneration: authority.providerGeneration }
      }, () => {
        instance = this.#ownership.requireRoute(scope, route);
        if (instance.lifecycleState !== "ready" || instance.viewerState !== "attached" ||
            !this.#driver.isReady(instance)) {
          throw new SimulatorDriverError("DRIVER_RUNTIME_LOST", "Simulator driver is not ready for input.");
        }
        admittedSnapshot = this.#screen.requireInteractionSnapshot(scope, route, action.snapshotId);
        this.#validateSnapshotTargets(action, admittedSnapshot);
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
    if (!instance || !admittedSnapshot) {
      throw new Error("Simulator input admission did not resolve its instance and snapshot.");
    }
    let attempted = false;
    let completedSteps = 0;
    try {
      this.#screen.invalidateInteraction(scope, route, action.snapshotId);
      const dispatched = await this.#dispatch(scope, route, instance, action, admittedSnapshot,
        observe, signal, () => { attempted = true; }, () => { completedSteps += 1; });
      let observation: SimulatorInteractionObservation | null = null;
      let observationError: SimulatorInputExecution["observationError"] = null;
      try {
        observation = action.type === "batch" && observe.mode === "immediate"
          ? dispatched.finalObservation
          : await this.#screen.observeAfter(scope, route, observe.mode, {
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
          generation: instance!.generation,
          backend: action.type === "touch_path" || action.type === "touch2_path" ? "native-hid" : "wda",
          completedAt: new Date(this.#now()).toISOString(),
          observationResult, ...(dispatched.completed === undefined ? {} : { completed: dispatched.completed }) }));
      return { receipt: completed.value, replayed: completed.replayed,
        observation: completed.replayed ? null : observation,
        observationError: completed.replayed ? null : observationError };
    } catch (error) {
      const safe = this.#inputFailure(error, attempted, completedSteps, signal);
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
    if (action.type === "batch") {
      if (observe.mode === "none" || !Array.isArray(action.actions) ||
          action.actions.length < 1 || action.actions.length > 16) {
        throw new SimulatorInputError("INVALID_ARGUMENT", "Simulator batch arguments are invalid.");
      }
      for (const item of action.actions) this.#validateOne(item, true);
    } else {
      this.#validateOne(action, false);
    }
  }

  #validateOne(action: Exclude<SimulatorInputAction, { readonly type: "batch" }> | SimulatorBatchAction,
    batch: boolean): void {
    if (action.type === "tap") {
      if ("target" in action) {
        if ("elementId" in action.target ? !validElementId(action.target.elementId) : !validPoint(action.target)) {
          throw new SimulatorInputError("INVALID_ARGUMENT", "Simulator tap target is invalid.");
        }
      } else if (!validElementId(action.elementId)) {
        throw new SimulatorInputError("INVALID_ARGUMENT", "Simulator element identity is invalid.");
      }
      return;
    }
    if (action.type === "swipe") {
      if (!validPoint(action.start) || !validPoint(action.end) || !Number.isSafeInteger(action.durationMs) ||
          action.durationMs < 50 || action.durationMs > (batch ? 10_000 : 60_000)) {
        throw new SimulatorInputError("INVALID_ARGUMENT", "Simulator swipe arguments are invalid.");
      }
      return;
    }
    if (action.type === "drag") {
      if (!validElementId(action.fromElementId) || !validElementId(action.toElementId) ||
          !Number.isSafeInteger(action.durationMs) || action.durationMs < 100 || action.durationMs > 10_000) {
        throw new SimulatorInputError("INVALID_ARGUMENT", "Simulator drag arguments are invalid.");
      }
      return;
    }
    if (action.type === "long_press") {
      if (!validElementId(action.elementId) || !Number.isSafeInteger(action.durationMs) ||
          action.durationMs < 300 || action.durationMs > 10_000) {
        throw new SimulatorInputError("INVALID_ARGUMENT", "Simulator long-press arguments are invalid.");
      }
      return;
    }
    if (action.type === "key_press") {
      if (!validKey(action.key)) {
        throw new SimulatorInputError("INVALID_ARGUMENT", "Simulator key is unsupported.");
      }
      return;
    }
    if (action.type === "type_text") {
      if (!validText(action.text)) {
        throw new SimulatorInputError("INVALID_ARGUMENT", "Simulator text input exceeds its limit.");
      }
      return;
    }
    if (action.type === "touch_path" || action.type === "touch2_path") {
      if (batch) throw new SimulatorInputError("INVALID_ARGUMENT", "Native touch is not a batch action.");
      try {
        const viewport = { width: 1_000_000, height: 1_000_000, orientation: "PORTRAIT" as const };
        if (action.type === "touch_path") {
          normalizeSimulatorTouchPath(action.points, viewport, action.edge);
        } else {
          normalizeSimulatorTouchPair(action.first, action.second, viewport);
        }
      } catch (error) {
        if (error instanceof SimulatorNativeTouchError) {
          throw new SimulatorInputError("INVALID_ARGUMENT", error.message);
        }
        throw error;
      }
      return;
    }
    if (action.type !== "press_home" || batch) {
      throw new SimulatorInputError("INVALID_ARGUMENT", "Simulator input action is invalid.");
    }
  }

  #validateSnapshotTargets(action: SimulatorInputAction, snapshot: SimulatorScreenMap): void {
    const candidate = action.type === "batch" ? action.actions[0] : action;
    if (!candidate) throw new SimulatorInputError("INVALID_ARGUMENT", "Simulator batch is empty.");
    if (candidate.type === "tap") {
      const target = "target" in candidate ? candidate.target : { elementId: candidate.elementId };
      if ("elementId" in target) elementPoint(snapshot, target.elementId);
    } else if (candidate.type === "drag") {
      elementPoint(snapshot, candidate.fromElementId);
      elementPoint(snapshot, candidate.toElementId);
    } else if (candidate.type === "long_press") {
      elementPoint(snapshot, candidate.elementId);
    }
  }

  async #dispatch(scope: SimulatorTaskScope, route: SimulatorInstanceRoute,
    instance: PublicSimulatorInstance, action: SimulatorInputAction, snapshot: SimulatorScreenMap,
    observe: SimulatorInputObserveOptions, signal: AbortSignal | undefined,
    onAttempt: () => void, onCompleted: () => void): Promise<{
      readonly completed?: readonly { readonly index: number;
        readonly type: SimulatorBatchAction["type"]; readonly backend: "wda" }[];
      readonly finalObservation: SimulatorInteractionObservation | null }> {
    if (action.type !== "batch") {
      await this.#performOne(scope, route, instance, action, snapshot, signal, onAttempt, onCompleted);
      return { finalObservation: null };
    }
    let current = snapshot;
    let finalObservation: SimulatorInteractionObservation | null = null;
    const completed: Array<{ index: number; type: SimulatorBatchAction["type"]; backend: "wda" }> = [];
    for (const [index, item] of action.actions.entries()) {
      if (index > 0) this.#screen.invalidateInteraction(scope, route, current.snapshotId);
      await this.#performOne(scope, route, instance, item, current, signal, onAttempt, onCompleted);
      finalObservation = await this.#screen.observeAfter(scope, route, "immediate", {
        timeoutMs: observe.timeoutMs, stableForMs: observe.stableForMs
      }, signal);
      if (!finalObservation) throw new Error("Simulator batch observation was not produced.");
      current = finalObservation.screenMap;
      completed.push({ index, type: item.type, backend: "wda" });
    }
    return { completed, finalObservation };
  }

  async #performOne(scope: SimulatorTaskScope, route: SimulatorInstanceRoute, instance: PublicSimulatorInstance,
    action: Exclude<SimulatorInputAction, { readonly type: "batch" }> | SimulatorBatchAction,
    snapshot: SimulatorScreenMap, signal: AbortSignal | undefined,
    onAttempt: () => void, onCompleted: () => void): Promise<void> {
    if (action.type === "tap") {
      const target = "target" in action ? action.target : { elementId: action.elementId };
      const point = "elementId" in target ? elementPoint(snapshot, target.elementId) : target;
      onAttempt();
      await this.#driver.tap(instance, point, signal);
    } else if (action.type === "swipe") {
      onAttempt();
      await this.#driver.swipe(instance, action.start, action.end, action.durationMs, signal);
    } else if (action.type === "drag") {
      const start = elementPoint(snapshot, action.fromElementId);
      const end = elementPoint(snapshot, action.toElementId);
      onAttempt();
      await this.#driver.swipe(instance, start, end, action.durationMs, signal);
    } else if (action.type === "long_press") {
      const point = elementPoint(snapshot, action.elementId);
      onAttempt();
      await this.#driver.swipe(instance, point, point, action.durationMs, signal);
    } else if (action.type === "key_press") {
      onAttempt();
      await this.#driver.typeText(instance, WEB_DRIVER_KEYS[action.key], signal);
    } else if (action.type === "type_text") {
      onAttempt();
      await this.#driver.typeText(instance, action.text, signal);
    } else if (action.type === "touch_path" || action.type === "touch2_path") {
      const viewport = await this.#driver.observeViewport(instance, signal);
      this.#ownership.requireRoute(scope, route);
      const paths = action.type === "touch_path"
        ? { first: normalizeSimulatorTouchPath(action.points, viewport, action.edge), second: undefined }
        : normalizeSimulatorTouchPair(action.first, action.second, viewport);
      if (!await this.#driver.probeNativeInput(instance, signal)) {
        throw new SimulatorInputError("NATIVE_INPUT_UNAVAILABLE",
          "Simulator native touch is unavailable; discrete WDA input remains available.");
      }
      this.#ownership.requireRoute(scope, route);
      onAttempt();
      await this.#driver.touchNativePath(instance, paths.first, paths.second, signal);
      if (!this.#driver.isReady(instance)) {
        throw new SimulatorInputError("INPUT_OUTCOME_UNKNOWN",
          "Simulator driver changed after native input; read a new screen map before retrying.");
      }
      try { this.#ownership.requireRoute(scope, route); }
      catch {
        throw new SimulatorInputError("INPUT_OUTCOME_UNKNOWN",
          "Simulator route changed after native input; read a new screen map before retrying.");
      }
    } else {
      onAttempt();
      await this.#driver.pressHome(instance, signal);
    }
    onCompleted();
  }

  #inputFailure(error: unknown, attempted: boolean, completedSteps: number,
    signal?: AbortSignal): Error {
    if (completedSteps > 0) {
      return new SimulatorInputError("INPUT_OUTCOME_UNKNOWN",
        "Simulator input stopped after one or more confirmed actions; read a new screen map before continuing.");
    }
    if (error instanceof SimulatorInputError || error instanceof SimulatorObservationError ||
        error instanceof SimulatorScreenMapError || error instanceof SimulatorOwnershipError) return error;
    if (error instanceof SimulatorNativeTouchError) {
      return new SimulatorInputError("INVALID_ARGUMENT", error.message);
    }
    if (error instanceof SimulatorNativeHidError) {
      if (error.code === "NATIVE_INPUT_UNAVAILABLE" && !attempted) {
        return new SimulatorInputError("NATIVE_INPUT_UNAVAILABLE", error.message);
      }
      if (error.code === "MUTATION_CANCELLED" && !attempted) {
        return new SimulatorInputError("MUTATION_CANCELLED", error.message);
      }
      return new SimulatorInputError("INPUT_OUTCOME_UNKNOWN",
        "Simulator native touch outcome is unknown; read a new screen map before retrying.");
    }
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
    if (signal?.aborted && !attempted) {
      return new SimulatorInputError("MUTATION_CANCELLED", "Simulator input was cancelled before dispatch.");
    }
    return new SimulatorInputError("INPUT_OUTCOME_UNKNOWN",
      "Simulator input outcome is unknown; read a new screen map before another action.");
  }

  #observationFailure(error: unknown, signal?: AbortSignal): { readonly code: string; readonly message: string } {
    if (error instanceof SimulatorObservationError || error instanceof SimulatorDriverError ||
        error instanceof SimulatorScreenMapError || error instanceof SimulatorOwnershipError ||
        error instanceof WdaClientError) {
      return { code: error.code, message: error.message };
    }
    if (signal?.aborted) {
      return { code: "OBSERVATION_CANCELLED", message: "Post-input Simulator observation was cancelled." };
    }
    return { code: "OBSERVATION_FAILED", message: "Post-input Simulator observation failed." };
  }
}
