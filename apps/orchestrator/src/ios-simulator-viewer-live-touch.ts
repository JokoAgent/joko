import { createHash } from "node:crypto";
import { OperationConflictError, OperationInProgressError, OperationPreviouslyFailedError,
  type OperationalStore } from "@joko/store";
import { SimulatorNativeHidError, type SimulatorNativeLiveContact,
  type SimulatorNativeLivePoint, type WdaViewport } from "@joko/tool-ios-simulator";
import { SimulatorDriverError, type SimulatorDriverCoordinator } from "./ios-simulator-driver-coordinator.js";
import { SimulatorInputError } from "./ios-simulator-input-coordinator.js";
import type { SimulatorOwnershipRegistry, PublicSimulatorInstance, SimulatorInstanceRoute,
  SimulatorTaskScope } from "./ios-simulator-ownership.js";
import type { SimulatorScreenObservationCoordinator } from "./ios-simulator-screen-observation.js";

const KIND = "ios_simulator_input";
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu;
const CONFLICTING_KINDS = new Set([
  KIND, "ios_simulator_instance_control", "ios_simulator_create", "ios_simulator_lifecycle",
  "ios_simulator_driver", "ios_simulator_state_control", "ios_simulator_app_build",
  "ios_simulator_app_install", "ios_simulator_app_control", "ios_simulator_url_control",
  "ios_simulator_screenshot", "ios_simulator_visual_capture", "ios_simulator_recording",
  "ios_simulator_grace_cleanup", "ios_simulator_removed_cleanup"
]);
const MAX_STEPS = 4_096;
const MAX_DURATION_MS = 60_000;
const IDLE_MS = 5_000;

export interface ViewerTouchPoint { readonly xRatio: number; readonly yRatio: number }
export type ViewerTouchPhase = "begin" | "move" | "end" | "cancel";
type LiveDriver = Pick<SimulatorDriverCoordinator,
  "isReady" | "probeNativeLiveInput" | "beginNativeLiveTouch">;
type LiveScreen = Pick<SimulatorScreenObservationCoordinator,
  "requireInteractionSnapshot" | "invalidateInteraction">;
interface ActiveTouch {
  readonly scope: SimulatorTaskScope;
  readonly route: SimulatorInstanceRoute;
  readonly operationId: string;
  readonly bodyHash: string;
  readonly contact: SimulatorNativeLiveContact;
  readonly orientation: WdaViewport["orientation"];
  readonly viewerOrientation: WdaViewport["orientation"];
  readonly startedAt: number;
  lastStepAt: number;
  sequence: number;
  pending: boolean;
  timeout: ReturnType<typeof setTimeout>;
}

function normalized(point: ViewerTouchPoint): boolean {
  return point !== null && typeof point === "object" && Number.isFinite(point.xRatio) &&
    Number.isFinite(point.yRatio) && point.xRatio >= 0 && point.xRatio <= 1 &&
    point.yRatio >= 0 && point.yRatio <= 1;
}

function nativePoint(point: ViewerTouchPoint, orientation: WdaViewport["orientation"],
  viewerOrientation: WdaViewport["orientation"]): SimulatorNativeLivePoint {
  if (orientation === "PORTRAIT" && viewerOrientation === "LANDSCAPE") {
    return { x: point.yRatio, y: 1 - point.xRatio };
  }
  if (orientation === "LANDSCAPE" && viewerOrientation === "PORTRAIT") {
    return { x: 1 - point.yRatio, y: point.xRatio };
  }
  return { x: point.xRatio, y: point.yRatio };
}

function inputFailure(error: unknown, dispatched: boolean): SimulatorInputError {
  if (!dispatched && (error instanceof SimulatorNativeHidError || error instanceof SimulatorDriverError) &&
      error.code === "NATIVE_INPUT_UNAVAILABLE") {
    return new SimulatorInputError("NATIVE_INPUT_UNAVAILABLE",
      "Simulator continuous touch is unavailable before dispatch.");
  }
  if (!dispatched && (error instanceof SimulatorNativeHidError || error instanceof SimulatorDriverError) &&
      error.code === "MUTATION_CANCELLED") {
    return new SimulatorInputError("MUTATION_CANCELLED", "Simulator touch was cancelled before dispatch.");
  }
  return new SimulatorInputError("INPUT_OUTCOME_UNKNOWN",
    "Simulator continuous touch outcome is unknown; refresh the screen before further input.");
}

/** A contact holds the same durable input mutex from native down through up/cancel. */
export class SimulatorViewerLiveTouchCoordinator {
  readonly #active = new Map<string, ActiveTouch>();
  readonly #store: OperationalStore;
  readonly #ownership: Pick<SimulatorOwnershipRegistry, "requireRoute">;
  readonly #driver: LiveDriver;
  readonly #screen: LiveScreen;
  readonly #now: () => number;

  constructor(store: OperationalStore, ownership: Pick<SimulatorOwnershipRegistry, "requireRoute">,
    driver: LiveDriver, screen: LiveScreen, now: () => number = Date.now) {
    this.#store = store;
    this.#ownership = ownership;
    this.#driver = driver;
    this.#screen = screen;
    this.#now = now;
  }

  #key(scope: SimulatorTaskScope, gestureId: string): string {
    return `${scope.sessionId}:${gestureId}`;
  }

  async begin(scope: SimulatorTaskScope, route: SimulatorInstanceRoute, gestureId: string,
    point: ViewerTouchPoint, snapshotId: string, viewport: WdaViewport,
    viewerOrientation: WdaViewport["orientation"], signal?: AbortSignal): Promise<void> {
    if (!UUID.test(gestureId) || !UUID.test(snapshotId) || !normalized(point) ||
        !["PORTRAIT", "LANDSCAPE"].includes(viewport.orientation) ||
        !["PORTRAIT", "LANDSCAPE"].includes(viewerOrientation)) {
      throw new SimulatorInputError("INVALID_ARGUMENT", "Simulator touch begin is invalid.");
    }
    if (signal?.aborted) throw new SimulatorInputError("MUTATION_CANCELLED",
      "Simulator touch was cancelled before admission.");
    const instance = this.#ownership.requireRoute(scope, route);
    if (!this.#driver.isReady(instance) || instance.lifecycleState !== "ready" ||
        instance.viewerState !== "attached") throw new SimulatorDriverError(
      "DRIVER_RUNTIME_LOST", "Simulator driver is not ready for touch.");
    if (!await this.#driver.probeNativeLiveInput(instance, signal)) throw new SimulatorInputError(
      "NATIVE_INPUT_UNAVAILABLE", "Simulator continuous touch is unavailable before dispatch.");
    const operationId = `ios-simulator-input:viewer-live:${createHash("sha256")
      .update(`${scope.sessionId}:${gestureId}`).digest("hex")}`;
    let admitted: PublicSimulatorInstance | undefined;
    let claim;
    try {
      claim = this.#store.claimDeferredEffectOperation({ id: operationId, kind: KIND,
        body: { action: "viewer_live_touch", sessionId: scope.sessionId, targetId: scope.targetId,
          bindingGeneration: scope.generation, instanceId: route.instanceId,
          instanceGeneration: route.generation, leaseId: route.leaseId, gestureId }
      }, () => {
        admitted = this.#ownership.requireRoute(scope, route);
        if (!this.#driver.isReady(admitted)) throw new SimulatorDriverError(
          "DRIVER_RUNTIME_LOST", "Simulator driver is not ready for touch.");
        this.#screen.requireInteractionSnapshot(scope, route, snapshotId);
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
      if (error instanceof OperationConflictError) throw new SimulatorInputError("MUTATION_CONFLICT",
        "Simulator touch identity was reused with different arguments.");
      if (error instanceof OperationInProgressError) throw new SimulatorInputError("MUTATION_IN_PROGRESS",
        "Another Simulator operation is in progress.");
      if (error instanceof OperationPreviouslyFailedError) throw new SimulatorInputError(
        "INPUT_OUTCOME_UNKNOWN", "Simulator touch previously failed and will not be dispatched again.");
      throw error;
    }
    if (!claim.claimed || !admitted) throw new SimulatorInputError("INPUT_OUTCOME_UNKNOWN",
      "Simulator touch identity was already consumed.");
    const key = this.#key(scope, gestureId);
    let contact: SimulatorNativeLiveContact | undefined;
    try {
      this.#screen.invalidateInteraction(scope, route, snapshotId);
      contact = await this.#driver.beginNativeLiveTouch(admitted, gestureId,
        nativePoint(point, viewport.orientation, viewerOrientation), signal);
      this.#ownership.requireRoute(scope, route);
      if (signal?.aborted) throw new Error("Touch admission was cancelled after native dispatch.");
      const active: ActiveTouch = { scope, route, operationId,
        bodyHash: claim.operation.bodyHash, contact,
        orientation: viewport.orientation, viewerOrientation,
        startedAt: this.#now(), lastStepAt: this.#now(), sequence: 0, pending: false,
        timeout: setTimeout(() => undefined, IDLE_MS) };
      clearTimeout(active.timeout);
      active.timeout = this.#watch(key, active);
      this.#active.set(key, active);
    } catch (error) {
      contact?.forceRelease();
      const safe = inputFailure(error, contact !== undefined ||
        !(error instanceof SimulatorNativeHidError || error instanceof SimulatorDriverError) ||
        error.code !== "NATIVE_INPUT_UNAVAILABLE");
      try { this.#store.failEffectOperation(operationId, claim.operation.bodyHash, safe); }
      catch { /* Startup recovery may have already fenced the effect. */ }
      throw safe;
    }
  }

  async advance(scope: SimulatorTaskScope, route: SimulatorInstanceRoute, gestureId: string,
    phase: Exclude<ViewerTouchPhase, "begin">, sequence: number, point: ViewerTouchPoint,
    signal?: AbortSignal): Promise<void> {
    if (!UUID.test(gestureId) || !normalized(point) || !Number.isSafeInteger(sequence) ||
        sequence < 1 || sequence >= MAX_STEPS || !["move", "end", "cancel"].includes(phase)) {
      throw new SimulatorInputError("INVALID_ARGUMENT", "Simulator touch step is invalid.");
    }
    const key = this.#key(scope, gestureId);
    const active = this.#active.get(key);
    if (!active) throw new SimulatorInputError("INPUT_OUTCOME_UNKNOWN",
      "Simulator touch is no longer active; refresh the screen before further input.");
    if (active.scope.sessionId !== scope.sessionId || active.scope.targetId !== scope.targetId ||
        active.scope.generation !== scope.generation || active.route.instanceId !== route.instanceId ||
        active.route.generation !== route.generation || active.route.leaseId !== route.leaseId) {
      throw new SimulatorInputError("MUTATION_CONFLICT", "Simulator touch route changed.");
    }
    if (active.pending || sequence !== active.sequence + 1 ||
        this.#now() - active.startedAt > MAX_DURATION_MS) {
      this.#fail(key, active);
      throw new SimulatorInputError("INPUT_OUTCOME_UNKNOWN",
        "Simulator touch sequence or duration changed; refresh the screen.");
    }
    active.pending = true;
    clearTimeout(active.timeout);
    try {
      if (phase === "move") {
        const delay = Math.max(0, 4 - (this.#now() - active.lastStepAt));
        if (delay > 0) await new Promise<void>(resolve => setTimeout(resolve, delay));
        if (this.#active.get(key) !== active) throw new Error(
          "Simulator touch was released before its next move.");
      }
      this.#ownership.requireRoute(scope, route);
      await active.contact[phase](nativePoint(point, active.orientation,
        active.viewerOrientation), sequence, signal);
      if (this.#active.get(key) !== active) throw new Error(
        "Simulator touch was released while a native step was pending.");
      this.#ownership.requireRoute(scope, route);
      if (signal?.aborted) throw new Error("Touch request was cancelled after native dispatch.");
      active.sequence = sequence;
      active.lastStepAt = this.#now();
      if (phase === "move") active.timeout = this.#watch(key, active);
      else {
        this.#store.completeDeferredEffectOperation(active.operationId, active.bodyHash,
          () => ({ action: "viewer_live_touch", backend: "native-hid",
            instanceId: route.instanceId, generation: route.generation,
            completedAt: new Date(this.#now()).toISOString(), terminal: phase }));
        this.#active.delete(key);
      }
    } catch (error) {
      this.#fail(key, active);
      throw inputFailure(error, true);
    } finally { active.pending = false; }
  }

  clearInstance(instanceId: string): void {
    for (const [key, active] of this.#active) {
      if (active.route.instanceId === instanceId) this.#fail(key, active);
    }
  }

  #watch(key: string, active: ActiveTouch): ReturnType<typeof setTimeout> {
    const timeout = setTimeout(() => this.#fail(key, active), IDLE_MS);
    timeout.unref?.();
    return timeout;
  }

  #fail(key: string, active: ActiveTouch): void {
    if (this.#active.get(key) !== active) return;
    this.#active.delete(key);
    clearTimeout(active.timeout);
    active.contact.forceRelease();
    try { this.#store.failEffectOperation(active.operationId, active.bodyHash,
      new SimulatorInputError("INPUT_OUTCOME_UNKNOWN",
        "Simulator touch was interrupted; refresh the screen before further input.")); }
    catch { /* Startup recovery may have already fenced the effect. */ }
  }
}
