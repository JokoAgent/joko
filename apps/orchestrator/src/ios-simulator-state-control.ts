import { OperationConflictError, OperationInProgressError, OperationPreviouslyFailedError,
  type OperationalStore } from "@joko/store";
import { JokoError } from "@joko/core";
import { createSimulatorLifecycleRuntime, serializeSimulatorPushPayload,
  SimulatorLifecycleError, SimulatorScreenMapError,
  WdaClientError, type SimulatorAppearance, type SimulatorContentSize,
  type SimulatorLifecycleRuntime, type SimulatorLocationRouteOptions,
  type SimulatorLocationWaypoint, type SimulatorPrivacyAction,
  type SimulatorStatusBarOverrides, type WdaViewport } from "@joko/tool-ios-simulator";
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
const PRIVACY_SERVICE = /^[a-z][a-z0-9-]{0,63}$/u;
const BUNDLE_ID = /^[A-Za-z0-9][A-Za-z0-9.-]{1,254}$/u;
const STATUS_BAR_KEYS = new Set([
  "time", "dataNetwork", "wifiMode", "wifiBars", "cellularMode", "cellularBars",
  "operatorName", "batteryState", "batteryLevel"
]);
const STATUS_BAR_DATA_NETWORKS = new Set([
  "hide", "wifi", "3g", "4g", "lte", "lte-a", "lte+", "5g", "5g+", "5g-uwb", "5g-uc"
]);
const STATUS_BAR_WIFI_MODES = new Set(["searching", "failed", "active"]);
const STATUS_BAR_CELLULAR_MODES = new Set(["notSupported", "searching", "failed", "active"]);
const STATUS_BAR_BATTERY_STATES = new Set(["charging", "charged", "discharging"]);
const CONFLICTING_KINDS = new Set([
  KIND, "ios_simulator_instance_control", "ios_simulator_create", "ios_simulator_lifecycle",
  "ios_simulator_driver", "ios_simulator_input", "ios_simulator_app_build", "ios_simulator_grace_cleanup",
  "ios_simulator_removed_cleanup"
]);

type StateDriver = Pick<SimulatorDriverCoordinator,
  "isReady" | "setOrientation" | "lockScreen" | "unlockScreen">;
type StateScreen = Pick<SimulatorScreenObservationCoordinator,
  "requireInteractionSnapshot" | "invalidateInteraction" | "invalidateRoute">;
type StateLifecycle = Pick<SimulatorLifecycleRuntime,
  "setAppearance" | "setIncreaseContrast" | "setContentSize" | "setLocation" |
  "startLocationRoute" | "clearLocation" | "setPrivacy" | "setStatusBar" |
  "clearStatusBar" | "pushNotification">;

export type SimulatorStateControlAction =
  | { readonly type: "set_orientation"; readonly snapshotId: string;
      readonly orientation: WdaViewport["orientation"] }
  | { readonly type: "set_appearance"; readonly appearance: SimulatorAppearance }
  | { readonly type: "set_increase_contrast"; readonly enabled: boolean }
  | { readonly type: "set_content_size"; readonly contentSize: SimulatorContentSize }
  | { readonly type: "set_location"; readonly latitude: number; readonly longitude: number }
  | { readonly type: "start_location_route"; readonly waypoints: readonly SimulatorLocationWaypoint[];
      readonly speedMetersPerSecond?: number; readonly intervalSeconds?: number;
      readonly distanceMeters?: number }
  | { readonly type: "clear_location" }
  | { readonly type: "set_privacy"; readonly action: SimulatorPrivacyAction;
      readonly service: string; readonly bundleId?: string }
  | { readonly type: "set_status_bar"; readonly overrides: SimulatorStatusBarOverrides }
  | { readonly type: "clear_status_bar" }
  | { readonly type: "push_notification"; readonly bundleId: string;
      readonly payload: Readonly<Record<string, unknown>> }
  | { readonly type: "lock_screen"; readonly snapshotId: string }
  | { readonly type: "unlock_screen"; readonly snapshotId: string };

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
  readonly latitude?: number;
  readonly longitude?: number;
  readonly waypointCount?: number;
  readonly action?: SimulatorPrivacyAction;
  readonly service?: string;
  readonly bundleId?: string | null;
  readonly delivered?: true;
  readonly overrides?: SimulatorStatusBarOverrides;
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

/** Durable boundary for device presentation, accessibility and environment-state mutations. */
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
          ...(action.type === "set_orientation" || action.type === "lock_screen" ||
            action.type === "unlock_screen" ? { snapshotId: action.snapshotId } : {}),
          requestBodyHash: authority.requestBodyHash,
          providerGeneration: authority.providerGeneration }
      }, () => {
        instance = this.#ownership.requireRoute(scope, route);
        if (instance.lifecycleState !== "ready" || instance.viewerState !== "attached" ||
            !this.#driver.isReady(instance)) {
          throw new SimulatorDriverError("DRIVER_RUNTIME_LOST",
            "Simulator driver is not ready for state control.");
        }
        if (action.type === "set_orientation" || action.type === "lock_screen" ||
            action.type === "unlock_screen") {
          this.#screen.requireInteractionSnapshot(scope, route, action.snapshotId);
        } else if (action.type === "set_appearance" && !this.#lifecycle.setAppearance ||
            action.type === "set_increase_contrast" && !this.#lifecycle.setIncreaseContrast ||
            action.type === "set_content_size" && !this.#lifecycle.setContentSize ||
            action.type === "set_location" && !this.#lifecycle.setLocation ||
            action.type === "start_location_route" && !this.#lifecycle.startLocationRoute ||
            action.type === "clear_location" && !this.#lifecycle.clearLocation ||
            action.type === "set_privacy" && !this.#lifecycle.setPrivacy ||
            action.type === "set_status_bar" && !this.#lifecycle.setStatusBar ||
            action.type === "clear_status_bar" && !this.#lifecycle.clearStatusBar ||
            action.type === "push_notification" && !this.#lifecycle.pushNotification) {
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
      } else if (action.type === "lock_screen" || action.type === "unlock_screen") {
        this.#screen.invalidateInteraction(scope, route, action.snapshotId);
        attempted = true;
        if (action.type === "lock_screen") await this.#driver.lockScreen(instance, signal);
        else await this.#driver.unlockScreen(instance, signal);
        result = { backend: "wda" };
      } else if (action.type === "set_appearance") {
        attempted = true;
        await this.#lifecycle.setAppearance!(instance.simulatorUdid, action.appearance, signal);
        result = { backend: "simctl", appearance: action.appearance };
      } else if (action.type === "set_increase_contrast") {
        attempted = true;
        await this.#lifecycle.setIncreaseContrast!(instance.simulatorUdid, action.enabled, signal);
        result = { backend: "simctl", enabled: action.enabled };
      } else if (action.type === "set_content_size") {
        attempted = true;
        await this.#lifecycle.setContentSize!(instance.simulatorUdid, action.contentSize, signal);
        result = { backend: "simctl", contentSize: action.contentSize };
      } else if (action.type === "set_location") {
        attempted = true;
        await this.#lifecycle.setLocation!(instance.simulatorUdid,
          action.latitude, action.longitude, signal);
        result = { backend: "simctl", latitude: action.latitude, longitude: action.longitude };
      } else if (action.type === "start_location_route") {
        attempted = true;
        const options: SimulatorLocationRouteOptions = {
          waypoints: action.waypoints,
          speedMetersPerSecond: action.speedMetersPerSecond,
          intervalSeconds: action.intervalSeconds,
          distanceMeters: action.distanceMeters
        };
        await this.#lifecycle.startLocationRoute!(instance.simulatorUdid, options, signal);
        result = { backend: "simctl", waypointCount: action.waypoints.length };
      } else if (action.type === "clear_location") {
        attempted = true;
        await this.#lifecycle.clearLocation!(instance.simulatorUdid, signal);
        result = { backend: "simctl" };
      } else if (action.type === "set_privacy") {
        attempted = true;
        await this.#lifecycle.setPrivacy!(instance.simulatorUdid, action.action,
          action.service, action.bundleId, signal);
        result = { backend: "simctl", action: action.action, service: action.service,
          bundleId: action.bundleId ?? null };
      } else if (action.type === "set_status_bar") {
        attempted = true;
        await this.#lifecycle.setStatusBar!(instance.simulatorUdid, action.overrides, signal);
        result = { backend: "simctl", overrides: action.overrides };
      } else if (action.type === "clear_status_bar") {
        attempted = true;
        await this.#lifecycle.clearStatusBar!(instance.simulatorUdid, signal);
        result = { backend: "simctl" };
      } else {
        attempted = true;
        await this.#lifecycle.pushNotification!(instance.simulatorUdid,
          action.bundleId, action.payload, signal);
        result = { backend: "simctl", bundleId: action.bundleId, delivered: true };
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
    } else if (action.type === "set_location") {
      this.#validateLocation(action.latitude, action.longitude, "Simulator location");
    } else if (action.type === "start_location_route") {
      if (!Array.isArray(action.waypoints) || action.waypoints.length < 2 ||
          action.waypoints.length > 64) {
        throw new SimulatorStateControlError("INVALID_ARGUMENT",
          "Simulator location route must contain between 2 and 64 waypoints.");
      }
      action.waypoints.forEach((waypoint, index) => {
        if (!waypoint || typeof waypoint !== "object") {
          throw new SimulatorStateControlError("INVALID_ARGUMENT",
            `Simulator location waypoint ${index} is invalid.`);
        }
        this.#validateLocation(waypoint.latitude, waypoint.longitude,
          `Simulator location waypoint ${index}`);
      });
      for (const [key, value, maximum] of [
        ["speedMetersPerSecond", action.speedMetersPerSecond, 10_000],
        ["intervalSeconds", action.intervalSeconds, 86_400],
        ["distanceMeters", action.distanceMeters, 10_000_000]
      ] as const) {
        if (value !== undefined && (!Number.isFinite(value) || value <= 0 || value > maximum)) {
          throw new SimulatorStateControlError("INVALID_ARGUMENT",
            `Simulator location route ${key} is invalid.`);
        }
      }
      if (action.intervalSeconds !== undefined && action.distanceMeters !== undefined) {
        throw new SimulatorStateControlError("INVALID_ARGUMENT",
          "Simulator location route interval and distance are mutually exclusive.");
      }
    } else if (action.type === "clear_location") {
      // The exact route and effect authority are the complete request shape.
    } else if (action.type === "set_privacy") {
      if (action.action !== "grant" && action.action !== "revoke" && action.action !== "reset" ||
          typeof action.service !== "string" || !PRIVACY_SERVICE.test(action.service) ||
          action.bundleId !== undefined && (typeof action.bundleId !== "string" ||
            !BUNDLE_ID.test(action.bundleId)) ||
          action.action !== "reset" && action.bundleId === undefined) {
        throw new SimulatorStateControlError("INVALID_ARGUMENT",
          "Simulator privacy control is invalid.");
      }
    } else if (action.type === "set_status_bar") {
      this.#validateStatusBar(action.overrides);
    } else if (action.type === "clear_status_bar") {
      // The exact route and effect authority are the complete request shape.
    } else if (action.type === "push_notification") {
      if (typeof action.bundleId !== "string" || !BUNDLE_ID.test(action.bundleId)) {
        throw new SimulatorStateControlError("INVALID_ARGUMENT",
          "Simulator push bundle identity is invalid.");
      }
      try { serializeSimulatorPushPayload(action.payload); }
      catch {
        throw new SimulatorStateControlError("INVALID_ARGUMENT", "Simulator push payload is invalid.");
      }
    } else if (action.type === "lock_screen" || action.type === "unlock_screen") {
      if (!UUID.test(action.snapshotId)) {
        throw new SimulatorStateControlError("INVALID_ARGUMENT",
          "Simulator screen snapshot identity is invalid.");
      }
    } else {
      throw new SimulatorStateControlError("INVALID_ARGUMENT", "Simulator state control is invalid.");
    }
  }

  #validateLocation(latitude: number, longitude: number, label: string): void {
    if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 ||
        !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
      throw new SimulatorStateControlError("INVALID_ARGUMENT", `${label} is invalid.`);
    }
  }

  #validateStatusBar(overrides: SimulatorStatusBarOverrides): void {
    if (!overrides || typeof overrides !== "object" || Array.isArray(overrides) ||
        Object.keys(overrides).some(key => !STATUS_BAR_KEYS.has(key))) {
      throw new SimulatorStateControlError("INVALID_ARGUMENT",
        "Simulator status-bar overrides are invalid.");
    }
    if (overrides.time !== undefined && (typeof overrides.time !== "string" ||
        !overrides.time.trim() || overrides.time.length > 128 || /[\0\r\n]/u.test(overrides.time)) ||
        overrides.dataNetwork !== undefined && !STATUS_BAR_DATA_NETWORKS.has(overrides.dataNetwork) ||
        overrides.wifiMode !== undefined && !STATUS_BAR_WIFI_MODES.has(overrides.wifiMode) ||
        overrides.wifiBars !== undefined && (!Number.isInteger(overrides.wifiBars) ||
          overrides.wifiBars < 0 || overrides.wifiBars > 3) ||
        overrides.cellularMode !== undefined && !STATUS_BAR_CELLULAR_MODES.has(overrides.cellularMode) ||
        overrides.cellularBars !== undefined && (!Number.isInteger(overrides.cellularBars) ||
          overrides.cellularBars < 0 || overrides.cellularBars > 4) ||
        overrides.operatorName !== undefined && (typeof overrides.operatorName !== "string" ||
          overrides.operatorName.length > 128 || /[\0\r\n]/u.test(overrides.operatorName)) ||
        overrides.batteryState !== undefined && !STATUS_BAR_BATTERY_STATES.has(overrides.batteryState) ||
        overrides.batteryLevel !== undefined && (!Number.isInteger(overrides.batteryLevel) ||
          overrides.batteryLevel < 0 || overrides.batteryLevel > 100) ||
        !Object.values(overrides).some(value => value !== undefined)) {
      throw new SimulatorStateControlError("INVALID_ARGUMENT",
        "Simulator status-bar overrides are invalid.");
    }
  }

  #failure(error: unknown, attempted: boolean, signal?: AbortSignal): Error {
    if (error instanceof WdaClientError && error.code === "ORIENTATION_UNSUPPORTED") {
      return new SimulatorStateControlError("ORIENTATION_UNSUPPORTED", error.message);
    }
    if (error instanceof WdaClientError && error.code === "CANCELLED") {
      return new SimulatorStateControlError("MUTATION_CANCELLED",
        "Simulator state control was cancelled before dispatch.");
    }
    if (error instanceof SimulatorLifecycleError && error.code === "SIMULATOR_CONTROL_FAILED") {
      return new SimulatorStateControlError(error.code, error.message);
    }
    if (error instanceof SimulatorLifecycleError && error.code === "MUTATION_CANCELLED") {
      return new SimulatorStateControlError(error.code, "Simulator state control was cancelled before dispatch.");
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
