import type { SimulatorMjpegFrame, SimulatorNativeH264Frame, WdaMjpegProfile,
  SimulatorNativeH264Profile } from "@joko/tool-ios-simulator";
import { SimulatorDriverError, type SimulatorDriverCoordinator } from "./ios-simulator-driver-coordinator.js";
import { SimulatorOwnershipRegistry, type PublicSimulatorInstance,
  type SimulatorInstanceRoute, type SimulatorTaskScope } from "./ios-simulator-ownership.js";

type FrameDriver = Pick<SimulatorDriverCoordinator,
  "isReady" | "mjpegConfigurationLease" | "configureMjpegProfile" | "streamMjpegFrames"> &
  Partial<Pick<SimulatorDriverCoordinator, "probeNativeH264" | "streamNativeH264Frames">>;
type FrameState = "connecting" | "streaming" | "reconnecting" | "disconnected";
const DEFAULT_MJPEG_PROFILE: WdaMjpegProfile = {
  framesPerSecond: 10, jpegQuality: 45, scalingPercent: 70
};
export interface SimulatorViewerVideoPreference {
  readonly preferNativeH264: boolean;
  readonly profile: SimulatorNativeH264Profile;
  readonly mjpegProfile?: WdaMjpegProfile;
}
interface FrameSubscription {
  readonly controller: AbortController;
  readonly route: SimulatorInstanceRoute;
  state: FrameState;
  sequence: number;
  lastFrameAt: string | null;
  encoding: "jpeg" | "h264";
  viewerOrientation: SimulatorNativeH264Profile["orientation"] | null;
  readonly mjpegProfile: WdaMjpegProfile;
}
interface MjpegConfigurationState {
  readonly leaseId: string;
  tail: Promise<void>;
  uncertain: boolean;
}
export interface SimulatorViewerFrameSnapshot {
  readonly adapter: "wda-mjpeg" | "native-h264";
  readonly encoding: "jpeg" | "h264";
  readonly state: FrameState;
  readonly sequence: number;
  readonly lastFrameAt: string | null;
}
export type SimulatorViewerFrameEvent =
  | { readonly kind: "connecting" | "reconnecting" | "disconnected";
    readonly attempt: number }
  | { readonly kind: "frame"; readonly sequence: number; readonly receivedAt: string;
    readonly bytes: Uint8Array }
  | { readonly kind: "h264"; readonly sequence: number; readonly receivedAt: string;
    readonly bytes: Uint8Array; readonly width: number; readonly height: number;
    readonly timestampMicros: number; readonly keyFrame: boolean; readonly format: "annex-b" };

export class SimulatorViewerFrameError extends Error {
  constructor(readonly code: "SUBSCRIPTION_LIMIT" | "PROFILE_CONFLICT" | "PROFILE_UNCERTAIN",
    message: string) { super(message); }
}

/** Visibility-scoped subscriptions. Encoded frames never enter durable task state. */
export class SimulatorViewerFrameCoordinator {
  readonly #ownership: SimulatorOwnershipRegistry;
  readonly #driver: FrameDriver;
  readonly #subscriptions = new Map<string, Set<FrameSubscription>>();
  readonly #mjpegConfiguration = new Map<string, MjpegConfigurationState>();

  constructor(ownership: SimulatorOwnershipRegistry, driver: FrameDriver) {
    this.#ownership = ownership;
    this.#driver = driver;
  }

  clear(instanceId: string): void {
    const subscriptions = this.#subscriptions.get(instanceId);
    for (const subscription of subscriptions ?? []) subscription.controller.abort();
    this.#subscriptions.delete(instanceId);
    if (this.#driver.mjpegConfigurationLease(instanceId) === null) {
      this.#mjpegConfiguration.delete(instanceId);
    }
  }

  snapshot(scope: SimulatorTaskScope,
    route: SimulatorInstanceRoute): SimulatorViewerFrameSnapshot | null {
    this.#requireReady(scope, route);
    const subscriptions = this.#subscriptions.get(route.instanceId);
    const current = [...(subscriptions ?? [])].filter(item => !item.controller.signal.aborted &&
      item.route.generation === route.generation && item.route.leaseId === route.leaseId);
    const preferred = current.find(item => item.state === "streaming") ?? current[0];
    return preferred ? { adapter: preferred.encoding === "h264" ? "native-h264" : "wda-mjpeg",
      encoding: preferred.encoding, state: preferred.state,
      sequence: preferred.sequence, lastFrameAt: preferred.lastFrameAt } : null;
  }

  inputView(scope: SimulatorTaskScope, route: SimulatorInstanceRoute): {
    readonly state: FrameState;
    readonly encoding: "jpeg" | "h264";
    readonly viewerOrientation: SimulatorNativeH264Profile["orientation"] | null;
    readonly lastFrameAt: string | null;
  } | null {
    this.#requireReady(scope, route);
    const current = [...(this.#subscriptions.get(route.instanceId) ?? [])]
      .filter(item => !item.controller.signal.aborted && item.route.generation === route.generation &&
        item.route.leaseId === route.leaseId);
    const preferred = current.find(item => item.state === "streaming") ?? current[0];
    return preferred ? { state: preferred.state, encoding: preferred.encoding,
      viewerOrientation: preferred.viewerOrientation, lastFrameAt: preferred.lastFrameAt } : null;
  }

  async *watch(scope: SimulatorTaskScope, route: SimulatorInstanceRoute,
    signal?: AbortSignal, preference?: SimulatorViewerVideoPreference): AsyncGenerator<SimulatorViewerFrameEvent> {
    const instance = this.#requireReady(scope, route);
    const subscriptions = this.#subscriptions.get(instance.instanceId) ?? new Set<FrameSubscription>();
    if (subscriptions.size >= 16 ||
        [...subscriptions].filter(item => !item.controller.signal.aborted).length >= 2) {
      throw new SimulatorViewerFrameError(
      "SUBSCRIPTION_LIMIT", "Simulator Viewer subscription limit reached.");
    }
    const controller = new AbortController();
    const subscription: FrameSubscription = { controller, route, state: "connecting",
      sequence: 0, lastFrameAt: null, encoding: "jpeg", viewerOrientation: null,
      mjpegProfile: preference?.mjpegProfile ?? DEFAULT_MJPEG_PROFILE };
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
      let useNative = false;
      if (preference?.preferNativeH264 && this.#driver.probeNativeH264 &&
          this.#driver.streamNativeH264Frames) {
        useNative = await this.#driver.probeNativeH264(instance, controller.signal);
        check();
        if (stale) throw stale;
      }
      subscription.encoding = useNative ? "h264" : "jpeg";
      subscription.viewerOrientation = useNative ? preference!.profile.orientation : null;
      for (let attempt = 0; attempt <= 3 && !controller.signal.aborted; attempt += 1) {
        check();
        if (stale) throw stale;
        subscription.state = attempt === 0 ? "connecting" : "reconnecting";
        subscription.lastFrameAt = null;
        yield { kind: attempt === 0 ? "connecting" : "reconnecting", attempt };
        try {
          if (useNative) {
            for await (const frame of this.#driver.streamNativeH264Frames!(instance,
              preference!.profile, controller.signal)) {
              check();
              if (stale) throw stale;
              if (controller.signal.aborted) return;
              subscription.state = "streaming";
              subscription.sequence += 1;
              subscription.lastFrameAt = frame.receivedAt;
              yield this.#h264Frame(subscription.sequence, frame);
            }
            useNative = false;
            subscription.encoding = "jpeg";
            subscription.viewerOrientation = null;
          } else {
            const peers = [...subscriptions].filter(item => item !== subscription &&
              !item.controller.signal.aborted && item.encoding === "jpeg");
            const older = [...subscriptions].slice(0, [...subscriptions].indexOf(subscription));
            if (peers.some(item => (item.state === "streaming" || older.includes(item)) &&
                !sameMjpegProfile(item.mjpegProfile, subscription.mjpegProfile))) {
              throw new SimulatorViewerFrameError("PROFILE_CONFLICT",
                "Another Viewer is using a different MJPEG stream profile.");
            }
            await this.#configureMjpeg(instance, subscription);
            check();
            if (stale) throw stale;
            if (controller.signal.aborted) return;
            for await (const frame of this.#driver.streamMjpegFrames(instance, controller.signal)) {
              check();
              if (stale) throw stale;
              if (controller.signal.aborted) return;
              subscription.state = "streaming";
              subscription.sequence += 1;
              subscription.lastFrameAt = frame.receivedAt;
              yield this.#frame(subscription.sequence, frame);
            }
          }
          if (stale) throw stale;
        } catch (error) {
          if (stale) throw stale;
          if (controller.signal.aborted) return;
          if (error instanceof SimulatorViewerFrameError) throw error;
          if (error instanceof SimulatorDriverError && error.code === "STALE_DRIVER") throw error;
          if (useNative) {
            useNative = false;
            subscription.encoding = "jpeg";
            subscription.viewerOrientation = null;
          }
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

  async #configureMjpeg(instance: PublicSimulatorInstance,
    subscription: FrameSubscription): Promise<void> {
    const key = instance.instanceId;
    const leaseId = this.#driver.mjpegConfigurationLease(key);
    if (leaseId === null) throw new SimulatorDriverError("STALE_DRIVER",
      "Simulator driver changed before stream configuration.");
    let state = this.#mjpegConfiguration.get(key);
    if (state?.leaseId !== leaseId) {
      state = { leaseId, tail: Promise.resolve(), uncertain: false };
      this.#mjpegConfiguration.set(key, state);
    }
    const configuration = state;
    const current = configuration.tail.then(async () => {
      if (subscription.controller.signal.aborted) return;
      if (configuration.uncertain) throw new SimulatorViewerFrameError(
        "PROFILE_UNCERTAIN", "The previous MJPEG profile outcome is unknown; restart the Viewer driver.");
      try {
        await this.#driver.configureMjpegProfile(instance, subscription.mjpegProfile,
          subscription.controller.signal);
      } catch (error) {
        if (!subscription.controller.signal.aborted) configuration.uncertain = true;
        throw error;
      }
    });
    configuration.tail = current.catch(() => undefined);
    await current;
  }

  #frame(sequence: number, frame: SimulatorMjpegFrame): SimulatorViewerFrameEvent {
    return { kind: "frame", sequence, receivedAt: frame.receivedAt, bytes: frame.bytes };
  }

  #h264Frame(sequence: number, frame: SimulatorNativeH264Frame): SimulatorViewerFrameEvent {
    return { kind: "h264", sequence, receivedAt: frame.receivedAt, bytes: frame.bytes,
      width: frame.width, height: frame.height, timestampMicros: frame.timestampMicros,
      keyFrame: frame.keyFrame, format: frame.format };
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

function sameMjpegProfile(left: WdaMjpegProfile, right: WdaMjpegProfile): boolean {
  return left.framesPerSecond === right.framesPerSecond &&
    left.jpegQuality === right.jpegQuality && left.scalingPercent === right.scalingPercent;
}
