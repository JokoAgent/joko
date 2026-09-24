import { createHash } from "node:crypto";
import { auditSimulatorScreenMap, diffSimulatorScreenMaps, SimulatorScreenMapError,
  SimulatorScreenMapStore, type SimulatorScreenElement, type SimulatorScreenMap,
  type WdaViewport } from "@joko/tool-ios-simulator";
import { SimulatorDriverError, type SimulatorDriverCoordinator } from "./ios-simulator-driver-coordinator.js";
import { SimulatorOwnershipRegistry, type PublicSimulatorInstance,
  type SimulatorInstanceRoute, type SimulatorTaskScope } from "./ios-simulator-ownership.js";

type ObserverDriver = Pick<SimulatorDriverCoordinator,
  "isReady" | "observeAccessibilityTree" | "observeViewport">;

export type SimulatorElementSelector = { readonly elementId?: string; readonly role?: string;
  readonly labelContains?: string; readonly valueContains?: string };
export type SimulatorWaitCondition =
  | { readonly kind: "element_exists" | "element_missing"; readonly selector: SimulatorElementSelector }
  | { readonly kind: "screen_changed"; readonly snapshotId: string }
  | { readonly kind: "screen_stable" };
export type SimulatorObserveAfterMode = "none" | "immediate" | "stable";
export type SimulatorInteractionObservation = { readonly mode: Exclude<SimulatorObserveAfterMode, "none">;
  readonly screenMap: SimulatorScreenMap; readonly elapsedMs: number;
  readonly stable: boolean; readonly timedOut: boolean };

export class SimulatorObservationError extends Error {
  constructor(readonly code: "INVALID_ARGUMENT" | "UI_WAIT_TIMEOUT" | "STALE_UI_SNAPSHOT" |
    "OBSERVATION_CANCELLED",
    message: string) { super(message); }
}

function fingerprint(screenMap: SimulatorScreenMap): string {
  return createHash("sha256").update(JSON.stringify(screenMap.elements)).digest("hex");
}

function matches(element: SimulatorScreenElement, selector: SimulatorElementSelector): boolean {
  return (selector.elementId === undefined || element.elementId === selector.elementId)
    && (selector.role === undefined || element.role === selector.role)
    && (selector.labelContains === undefined || (element.label ?? "").toLocaleLowerCase()
      .includes(selector.labelContains.toLocaleLowerCase()))
    && (selector.valueContains === undefined || (element.value ?? "").toLocaleLowerCase()
      .includes(selector.valueContains.toLocaleLowerCase()));
}

async function pause(durationMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new SimulatorObservationError("OBSERVATION_CANCELLED", "Simulator observation was cancelled.");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, durationMs);
    const abort = (): void => { clearTimeout(timer); reject(new SimulatorObservationError(
      "OBSERVATION_CANCELLED", "Simulator observation was cancelled.")); };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

/** Process-local screen observations, fenced by the current durable instance route and driver. */
export class SimulatorScreenObservationCoordinator {
  readonly #ownership: SimulatorOwnershipRegistry;
  readonly #driver: ObserverDriver;
  readonly #maps = new SimulatorScreenMapStore();
  readonly #flight = new Map<string, symbol>();

  constructor(ownership: SimulatorOwnershipRegistry, driver: ObserverDriver) {
    this.#ownership = ownership;
    this.#driver = driver;
  }

  async screenMap(scope: SimulatorTaskScope, route: SimulatorInstanceRoute,
    signal?: AbortSignal): Promise<{ readonly screenMap: SimulatorScreenMap;
      readonly viewport: WdaViewport }> {
    const instance = this.#requireReady(scope, route);
    const [screenMap, viewport] = await Promise.all([
      this.#capture(scope, route, instance, signal), this.#driver.observeViewport(instance, signal)
    ]);
    if (signal?.aborted) throw new SimulatorObservationError("OBSERVATION_CANCELLED", "Simulator observation was cancelled.");
    this.#requireReady(scope, route);
    if (this.#maps.current(instance.instanceId)?.snapshotId !== screenMap.snapshotId) {
      throw new SimulatorScreenMapError("STALE_UI_SNAPSHOT", "Simulator observation was superseded.");
    }
    return { screenMap, viewport };
  }

  async audit(scope: SimulatorTaskScope, route: SimulatorInstanceRoute, maxViolations = 200,
    signal?: AbortSignal) {
    const current = await this.#capture(scope, route, this.#requireReady(scope, route), signal);
    return { audit: auditSimulatorScreenMap(current, maxViolations) };
  }

  async compare(scope: SimulatorTaskScope, route: SimulatorInstanceRoute,
    baseline: SimulatorScreenMap, maxChanges = 200, signal?: AbortSignal) {
    if (baseline.instanceId !== route.instanceId || baseline.generation !== route.generation) {
      throw new SimulatorObservationError("STALE_UI_SNAPSHOT", "Simulator baseline belongs to another route.");
    }
    const current = await this.#capture(scope, route, this.#requireReady(scope, route), signal);
    return { diff: diffSimulatorScreenMaps(baseline, current, maxChanges) };
  }

  async wait(scope: SimulatorTaskScope, route: SimulatorInstanceRoute, condition: SimulatorWaitCondition,
    options: { readonly timeoutMs?: number; readonly pollIntervalMs?: number;
      readonly stableForMs?: number; readonly returnOnTimeout?: boolean } = {}, signal?: AbortSignal): Promise<{
        readonly screenMap: SimulatorScreenMap; readonly elapsedMs: number;
        readonly stable: boolean; readonly timedOut: boolean }> {
    const timeoutMs = options.timeoutMs ?? 10_000;
    const pollIntervalMs = options.pollIntervalMs ?? 250;
    const stableForMs = options.stableForMs ?? 300;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000 ||
        !Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 100 || pollIntervalMs > 2_000 ||
        !Number.isSafeInteger(stableForMs) || stableForMs < 100 || stableForMs > 2_000) {
      throw new SimulatorObservationError("INVALID_ARGUMENT", "Simulator wait bounds are invalid.");
    }
    const instance = this.#requireReady(scope, route);
    let baseline: string | null = null;
    if (condition.kind === "screen_changed") {
      baseline = fingerprint(this.#maps.requireCurrent({ instanceId: route.instanceId,
        generation: route.generation, snapshotId: condition.snapshotId }));
    }
    const started = Date.now();
    const deadline = started + timeoutMs;
    let previous: string | null = null;
    let stableSince = started;
    let lastScreenMap: SimulatorScreenMap | null = null;
    const timeout = (): { readonly screenMap: SimulatorScreenMap; readonly elapsedMs: number;
      readonly stable: false; readonly timedOut: true } => {
      if (options.returnOnTimeout && lastScreenMap) {
        return { screenMap: lastScreenMap, elapsedMs: Date.now() - started,
          stable: false, timedOut: true };
      }
      throw new SimulatorObservationError("UI_WAIT_TIMEOUT", "Simulator UI condition did not become true.");
    };
    for (;;) {
      if (signal?.aborted) throw new SimulatorObservationError("OBSERVATION_CANCELLED", "Simulator observation was cancelled.");
      const remaining = deadline - Date.now();
      if (remaining <= 0) return timeout();
      const bounded = new AbortController();
      const cancel = (): void => bounded.abort();
      signal?.addEventListener("abort", cancel, { once: true });
      const timer = setTimeout(cancel, remaining);
      if (signal?.aborted) cancel();
      let screenMap: SimulatorScreenMap;
      try { screenMap = await this.#capture(scope, route, instance, bounded.signal); }
      catch (error) {
        if (signal?.aborted) throw new SimulatorObservationError("OBSERVATION_CANCELLED", "Simulator observation was cancelled.");
        if (bounded.signal.aborted) return timeout();
        throw error;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", cancel);
      }
      lastScreenMap = screenMap;
      const current = fingerprint(screenMap);
      const now = Date.now();
      if (now > deadline) return timeout();
      if (current !== previous) { previous = current; stableSince = now; }
      const matched = condition.kind === "screen_changed" ? current !== baseline
        : condition.kind === "screen_stable" ? now - stableSince >= stableForMs
          : condition.kind === "element_exists"
            ? screenMap.elements.some(element => matches(element, condition.selector))
            : !screenMap.elements.some(element => matches(element, condition.selector));
      if (matched) return { screenMap, elapsedMs: now - started,
        stable: condition.kind === "screen_stable", timedOut: false };
      if (now >= deadline) return timeout();
      await pause(Math.min(pollIntervalMs, deadline - now), signal);
    }
  }

  requireInteractionSnapshot(scope: SimulatorTaskScope, route: SimulatorInstanceRoute,
    snapshotId: string): SimulatorScreenMap {
    this.#requireReady(scope, route);
    return this.#maps.requireCurrent({ instanceId: route.instanceId,
      generation: route.generation, snapshotId });
  }

  invalidateInteraction(scope: SimulatorTaskScope, route: SimulatorInstanceRoute,
    snapshotId: string): number {
    this.requireInteractionSnapshot(scope, route, snapshotId);
    return this.#maps.invalidate(route.instanceId);
  }

  async observeAfter(scope: SimulatorTaskScope, route: SimulatorInstanceRoute,
    mode: SimulatorObserveAfterMode, options: { readonly timeoutMs: number;
      readonly stableForMs: number }, signal?: AbortSignal): Promise<SimulatorInteractionObservation | null> {
    if (mode === "none") return null;
    if (mode === "immediate") {
      const observed = await this.screenMap(scope, route, signal);
      return { mode, screenMap: observed.screenMap, elapsedMs: 0, stable: false, timedOut: false };
    }
    const observed = await this.wait(scope, route, { kind: "screen_stable" }, {
      timeoutMs: options.timeoutMs, pollIntervalMs: 100,
      stableForMs: options.stableForMs, returnOnTimeout: true
    }, signal);
    return { mode, ...observed };
  }

  clear(instanceId: string): void {
    this.#flight.delete(instanceId);
    this.#maps.clear(instanceId);
  }

  #requireReady(scope: SimulatorTaskScope, route: SimulatorInstanceRoute): PublicSimulatorInstance {
    const instance = this.#ownership.requireRoute(scope, route);
    if (instance.lifecycleState !== "ready" || instance.viewerState !== "attached" ||
        !this.#driver.isReady(instance)) {
      throw new SimulatorDriverError("DRIVER_RUNTIME_LOST", "Simulator driver is not ready for observation.");
    }
    return instance;
  }

  async #capture(scope: SimulatorTaskScope, route: SimulatorInstanceRoute,
    instance: PublicSimulatorInstance, signal?: AbortSignal): Promise<SimulatorScreenMap> {
    const flight = Symbol();
    this.#flight.set(instance.instanceId, flight);
    try {
      const observed = await this.#driver.observeAccessibilityTree(instance, signal);
      if (signal?.aborted) throw new SimulatorObservationError("OBSERVATION_CANCELLED", "Simulator observation was cancelled.");
      this.#requireReady(scope, route);
      if (this.#flight.get(instance.instanceId) !== flight) {
        throw new SimulatorScreenMapError("STALE_UI_SNAPSHOT", "Simulator observation was superseded.");
      }
      return this.#maps.capture({ instanceId: instance.instanceId, generation: instance.generation,
        capturedAt: observed.capturedAt, tree: observed.tree });
    } finally {
      if (this.#flight.get(instance.instanceId) === flight) this.#flight.delete(instance.instanceId);
    }
  }
}
