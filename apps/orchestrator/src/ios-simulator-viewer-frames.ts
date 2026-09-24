import type { SimulatorMjpegFrame } from "@joko/tool-ios-simulator";
import { SimulatorDriverError, type SimulatorDriverCoordinator } from "./ios-simulator-driver-coordinator.js";
import { SimulatorOwnershipRegistry, type PublicSimulatorInstance,
  type SimulatorInstanceRoute, type SimulatorTaskScope } from "./ios-simulator-ownership.js";

type FrameDriver = Pick<SimulatorDriverCoordinator, "isReady" | "streamMjpegFrames">;
type FrameState = "connecting" | "streaming" | "reconnecting" | "disconnected";
interface FrameSubscription {
  readonly controller: AbortController;
  readonly route: SimulatorInstanceRoute;
  state: FrameState;
  sequence: number;
  lastFrameAt: string | null;
}
export interface SimulatorViewerFrameSnapshot {
  readonly adapter: "wda-mjpeg";
  readonly encoding: "jpeg";
  readonly state: FrameState;
  readonly sequence: number;
  readonly lastFrameAt: string | null;
}
export type SimulatorViewerFrameEvent =
  | { readonly kind: "connecting" | "reconnecting" | "disconnected";
    readonly attempt: number }
  | { readonly kind: "frame"; readonly sequence: number; readonly receivedAt: string;
    readonly bytes: Uint8Array };

export class SimulatorViewerFrameError extends Error {
  constructor(readonly code: "SUBSCRIPTION_LIMIT", message: string) { super(message); }
}

/** Visibility-scoped subscriptions. Encoded frames never enter durable task state. */
export class SimulatorViewerFrameCoordinator {
  readonly #ownership: SimulatorOwnershipRegistry;
  readonly #driver: FrameDriver;
  readonly #subscriptions = new Map<string, Set<FrameSubscription>>();

  constructor(ownership: SimulatorOwnershipRegistry, driver: FrameDriver) {
    this.#ownership = ownership;
    this.#driver = driver;
  }

  clear(instanceId: string): void {
    const subscriptions = this.#subscriptions.get(instanceId);
    for (const subscription of subscriptions ?? []) subscription.controller.abort();
    this.#subscriptions.delete(instanceId);
  }

  snapshot(scope: SimulatorTaskScope,
    route: SimulatorInstanceRoute): SimulatorViewerFrameSnapshot | null {
    this.#requireReady(scope, route);
    const subscriptions = this.#subscriptions.get(route.instanceId);
    const current = [...(subscriptions ?? [])].filter(item => !item.controller.signal.aborted &&
      item.route.generation === route.generation && item.route.leaseId === route.leaseId);
    const preferred = current.find(item => item.state === "streaming") ?? current[0];
    return preferred ? { adapter: "wda-mjpeg", encoding: "jpeg", state: preferred.state,
      sequence: preferred.sequence, lastFrameAt: preferred.lastFrameAt } : null;
  }

  async *watch(scope: SimulatorTaskScope, route: SimulatorInstanceRoute,
    signal?: AbortSignal): AsyncGenerator<SimulatorViewerFrameEvent> {
    const instance = this.#requireReady(scope, route);
    const subscriptions = this.#subscriptions.get(instance.instanceId) ?? new Set<FrameSubscription>();
    if (subscriptions.size >= 2) throw new SimulatorViewerFrameError(
      "SUBSCRIPTION_LIMIT", "Simulator Viewer subscription limit reached.");
    const controller = new AbortController();
    const subscription: FrameSubscription = { controller, route, state: "connecting",
      sequence: 0, lastFrameAt: null };
    subscriptions.add(subscription);
    this.#subscriptions.set(instance.instanceId, subscriptions);
    const abort = (): void => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    let stale: unknown;
    let nextHeartbeat = Date.now() + 20_000;
    const check = (): void => {
      if (controller.signal.aborted) return;
      try {
        const current = this.#requireReady(scope, route);
        if (current.simulatorUdid !== instance.simulatorUdid) throw new SimulatorDriverError("STALE_DRIVER",
          "Simulator Viewer device changed during streaming.");
        if (Date.now() >= nextHeartbeat) {
          this.#ownership.heartbeatRoute(scope, route);
          nextHeartbeat = Date.now() + 20_000;
        }
      } catch (error) { stale = error; controller.abort(); }
    };
    const fencer = setInterval(check, 500);
    try {
      for (let attempt = 0; attempt <= 3 && !controller.signal.aborted; attempt += 1) {
        check();
        if (stale) throw stale;
        subscription.state = attempt === 0 ? "connecting" : "reconnecting";
        subscription.lastFrameAt = null;
        yield { kind: attempt === 0 ? "connecting" : "reconnecting", attempt };
        try {
          for await (const frame of this.#driver.streamMjpegFrames(instance, controller.signal)) {
            check();
            if (stale) throw stale;
            if (controller.signal.aborted) return;
            subscription.state = "streaming";
            subscription.sequence += 1;
            subscription.lastFrameAt = frame.receivedAt;
            yield this.#frame(subscription.sequence, frame);
          }
          if (stale) throw stale;
        } catch (error) {
          if (stale) throw stale;
          if (controller.signal.aborted) return;
          if (error instanceof SimulatorDriverError && error.code === "STALE_DRIVER") throw error;
          if (attempt === 3) break;
          await this.#delay([250, 1_000, 2_000][attempt]!, controller.signal);
          continue;
        }
        if (controller.signal.aborted) return;
        if (attempt === 3) break;
        await this.#delay([250, 1_000, 2_000][attempt]!, controller.signal);
      }
      if (stale) throw stale;
      if (!controller.signal.aborted) {
        subscription.state = "disconnected";
        subscription.lastFrameAt = null;
        yield { kind: "disconnected", attempt: 3 };
      }
    } finally {
      clearInterval(fencer);
      signal?.removeEventListener("abort", abort);
      controller.abort();
      subscriptions.delete(subscription);
      if (subscriptions.size === 0 && this.#subscriptions.get(instance.instanceId) === subscriptions) {
        this.#subscriptions.delete(instance.instanceId);
      }
    }
  }

  #requireReady(scope: SimulatorTaskScope, route: SimulatorInstanceRoute): PublicSimulatorInstance {
    const instance = this.#ownership.requireRoute(scope, route);
    if (instance.viewerState !== "attached" || instance.lifecycleState !== "ready" ||
        !this.#driver.isReady(instance)) throw new SimulatorDriverError("DRIVER_RUNTIME_LOST",
          "Simulator Viewer driver is not ready.");
    return instance;
  }

  #frame(sequence: number, frame: SimulatorMjpegFrame): SimulatorViewerFrameEvent {
    return { kind: "frame", sequence, receivedAt: frame.receivedAt, bytes: frame.bytes };
  }

  async #delay(milliseconds: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => { signal.removeEventListener("abort", stop); resolve(); }, milliseconds);
      const stop = (): void => { clearTimeout(timer); signal.removeEventListener("abort", stop); resolve(); };
      signal.addEventListener("abort", stop, { once: true });
      if (signal.aborted) stop();
    });
  }
}
