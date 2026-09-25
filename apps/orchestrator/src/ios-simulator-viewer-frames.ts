import { randomUUID } from "node:crypto";
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
const INTERACTION_MJPEG_PROFILE: WdaMjpegProfile = {
  framesPerSecond: 20, jpegQuality: 70, scalingPercent: 100
};
const INTERACTION_NATIVE_PROFILE = {
  framesPerSecond: 30, scalingPercent: 100
} as const;
export interface SimulatorViewerVideoPreference {
  readonly preferNativeH264: boolean;
  readonly profile: SimulatorNativeH264Profile;
  readonly mjpegProfile?: WdaMjpegProfile;
  readonly clientFallbackReason?: "decode_failed";
}
export type SimulatorViewerNativeRouteState = "inactive" | "active" |
  "fallback_unavailable" | "fallback_lost" | "fallback_decode";
interface FrameSubscription {
  readonly id: string;
  readonly scope: SimulatorTaskScope;
  readonly controller: AbortController;
  readonly route: SimulatorInstanceRoute;
  readonly baseProfile: SimulatorNativeH264Profile;
  readonly baseMjpegProfile: WdaMjpegProfile;
  state: FrameState;
  sequence: number;
  lastFrameAt: string | null;
  encoding: "jpeg" | "h264";
  viewerOrientation: SimulatorNativeH264Profile["orientation"] | null;
  nativeRoute: SimulatorViewerNativeRouteState;
  profile: SimulatorNativeH264Profile;
  mjpegProfile: WdaMjpegProfile;
  profileRevision: number;
  profileTail: Promise<void>;
  interactionActive: boolean;
  closing: boolean;
  sourceController?: AbortController;
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
    readonly attempt: number; readonly nativeRoute: SimulatorViewerNativeRouteState }
  | { readonly kind: "frame"; readonly sequence: number; readonly receivedAt: string;
    readonly bytes: Uint8Array; readonly nativeRoute: SimulatorViewerNativeRouteState }
  | { readonly kind: "h264"; readonly sequence: number; readonly receivedAt: string;
    readonly bytes: Uint8Array; readonly width: number; readonly height: number;
    readonly timestampMicros: number; readonly keyFrame: boolean; readonly format: "annex-b";
    readonly nativeRoute: SimulatorViewerNativeRouteState };

export class SimulatorViewerFrameError extends Error {
  constructor(readonly code: "SUBSCRIPTION_LIMIT" | "SUBSCRIPTION_CONFLICT" |
    "SUBSCRIPTION_NOT_FOUND" | "SUBSCRIPTION_NOT_READY" | "PROFILE_CONFLICT" |
    "PROFILE_UNCERTAIN",
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

  /** Applies an exact subscription's temporary interaction profile without rebuilding its Viewer stream. */
  async setInteractionProfile(scope: SimulatorTaskScope, route: SimulatorInstanceRoute,
    subscriptionId: string, active: boolean): Promise<boolean> {
    const instance = this.#requireReady(scope, route);
    const subscriptions = this.#subscriptions.get(route.instanceId);
    const subscription = [...(subscriptions ?? [])].find(item => !item.controller.signal.aborted &&
      !item.closing && item.id === subscriptionId && item.scope.sessionId === scope.sessionId &&
      item.scope.targetId === scope.targetId && item.scope.generation === scope.generation &&
      item.route.generation === route.generation && item.route.leaseId === route.leaseId);
    if (!subscription) throw new SimulatorViewerFrameError("SUBSCRIPTION_NOT_FOUND",
      "The Simulator Viewer subscription is no longer current.");
    if (active && !freshSubscription(subscription)) throw new SimulatorViewerFrameError(
      "SUBSCRIPTION_NOT_READY", "The Simulator Viewer subscription has no fresh visible frame.");
    const shouldBoost = subscription.baseProfile.framesPerSecond <
      INTERACTION_NATIVE_PROFILE.framesPerSecond;
    if (!shouldBoost) return false;
    const apply = subscription.profileTail.then(() => {
      if (subscription.closing && active) return false;
      return this.#applyInteractionProfile(instance, subscriptions!, subscription, active);
    });
    subscription.profileTail = apply.then(() => undefined, () => undefined);
    return apply;
  }

  async *watch(scope: SimulatorTaskScope, route: SimulatorInstanceRoute,
    signal?: AbortSignal, preference?: SimulatorViewerVideoPreference,
    subscriptionId: string = randomUUID()): AsyncGenerator<SimulatorViewerFrameEvent> {
    const instance = this.#requireReady(scope, route);
    const subscriptions = this.#subscriptions.get(instance.instanceId) ?? new Set<FrameSubscription>();
    if (subscriptions.size >= 16 ||
        [...subscriptions].filter(item => !item.controller.signal.aborted).length >= 2) {
      throw new SimulatorViewerFrameError(
      "SUBSCRIPTION_LIMIT", "Simulator Viewer subscription limit reached.");
    }
    if ([...subscriptions].some(item => !item.controller.signal.aborted && item.id === subscriptionId)) {
      throw new SimulatorViewerFrameError(
        "SUBSCRIPTION_CONFLICT", "Simulator Viewer subscription identity is already active.");
    }
    const controller = new AbortController();
    const baseProfile = preference?.profile ?? {
      framesPerSecond: 20, scalingPercent: 70, orientation: "PORTRAIT"
    };
    const baseMjpegProfile = preference?.mjpegProfile ?? DEFAULT_MJPEG_PROFILE;
    const subscription: FrameSubscription = { id: subscriptionId, scope, controller, route,
      baseProfile, baseMjpegProfile, profile: baseProfile,
      profileRevision: 0, profileTail: Promise.resolve(), interactionActive: false, closing: false,
      state: "connecting",
      sequence: 0, lastFrameAt: null, encoding: "jpeg", viewerOrientation: null,
      nativeRoute: preference?.clientFallbackReason === "decode_failed" ? "fallback_decode" : "inactive",
      mjpegProfile: baseMjpegProfile };
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
      if (preference?.preferNativeH264) subscription.nativeRoute = useNative
        ? "active" : "fallback_unavailable";
      subscription.encoding = useNative ? "h264" : "jpeg";
      subscription.viewerOrientation = useNative ? subscription.profile.orientation : null;
      for (let attempt = 0; attempt <= 3 && !controller.signal.aborted; attempt += 1) {
        check();
        if (stale) throw stale;
        subscription.state = attempt === 0 ? "connecting" : "reconnecting";
        subscription.lastFrameAt = null;
        yield { kind: attempt === 0 ? "connecting" : "reconnecting", attempt,
          nativeRoute: subscription.nativeRoute };
        try {
          if (useNative) {
            while (!controller.signal.aborted) {
              const profileRevision = subscription.profileRevision;
              const profile = subscription.profile;
              const sourceController = new AbortController();
              subscription.sourceController = sourceController;
              const stopSource = (): void => sourceController.abort();
              controller.signal.addEventListener("abort", stopSource, { once: true });
              if (controller.signal.aborted) stopSource();
              let sourceError: unknown;
              try {
                for await (const frame of this.#driver.streamNativeH264Frames!(instance,
                  profile, sourceController.signal)) {
                  check();
                  if (stale) throw stale;
                  if (controller.signal.aborted) return;
                  subscription.state = "streaming";
                  subscription.viewerOrientation = profile.orientation;
                  subscription.sequence += 1;
                  subscription.lastFrameAt = frame.receivedAt;
                  yield this.#h264Frame(subscription, frame);
                }
              } catch (error) { sourceError = error; }
              finally {
                controller.signal.removeEventListener("abort", stopSource);
                if (subscription.sourceController === sourceController) {
                  subscription.sourceController = undefined;
                }
                sourceController.abort();
              }
              if (controller.signal.aborted) return;
              if (subscription.profileRevision !== profileRevision) continue;
              if (sourceError !== undefined) throw sourceError;
              break;
            }
            useNative = false;
            subscription.encoding = "jpeg";
            subscription.viewerOrientation = null;
            subscription.nativeRoute = "fallback_lost";
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
              yield this.#frame(subscription, frame);
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
            subscription.nativeRoute = "fallback_lost";
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
        yield { kind: "disconnected", attempt: 3, nativeRoute: subscription.nativeRoute };
      }
    } finally {
      clearInterval(fencer);
      signal?.removeEventListener("abort", abort);
      subscription.closing = true;
      subscription.sourceController?.abort();
      controller.abort();
      await subscription.profileTail;
      if (subscription.interactionActive) {
        await this.#applyInteractionProfile(instance, subscriptions, subscription, false)
          .catch(() => undefined);
      }
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

  async #applyInteractionProfile(instance: PublicSimulatorInstance,
    subscriptions: Set<FrameSubscription>, subscription: FrameSubscription,
    active: boolean): Promise<boolean> {
    const configuration = this.#mjpegConfiguration.get(instance.instanceId);
    if (configuration?.leaseId === this.#driver.mjpegConfigurationLease(instance.instanceId) &&
        configuration.uncertain) throw new SimulatorViewerFrameError(
      "PROFILE_UNCERTAIN", "The previous MJPEG profile outcome is unknown; restart the Viewer driver.");
    const targetProfile: SimulatorNativeH264Profile = active
      ? { ...INTERACTION_NATIVE_PROFILE, orientation: subscription.baseProfile.orientation }
      : subscription.baseProfile;
    const targetMjpegProfile = active ? INTERACTION_MJPEG_PROFILE : subscription.baseMjpegProfile;
    if (sameNativeProfile(subscription.profile, targetProfile) &&
        sameMjpegProfile(subscription.mjpegProfile, targetMjpegProfile)) {
      subscription.interactionActive = active;
      return false;
    }
    const peers = [...subscriptions].filter(item => item !== subscription && !item.closing &&
      !item.controller.signal.aborted && item.encoding === "jpeg");
    if (peers.some(item => !sameMjpegProfile(item.mjpegProfile, targetMjpegProfile))) {
      throw new SimulatorViewerFrameError("PROFILE_CONFLICT",
        "Another Viewer is using a different MJPEG stream profile.");
    }
    const current = this.#requireReady(subscription.scope, subscription.route);
    if (current.simulatorUdid !== instance.simulatorUdid) throw new SimulatorDriverError(
      "STALE_DRIVER", "Simulator Viewer device changed before stream configuration.");
    await this.#configureMjpeg(current, subscription, targetMjpegProfile, null);
    subscription.mjpegProfile = targetMjpegProfile;
    if (!sameNativeProfile(subscription.profile, targetProfile)) {
      subscription.profile = targetProfile;
      subscription.profileRevision += 1;
      subscription.sourceController?.abort();
    }
    subscription.interactionActive = active;
    const confirmed = this.#requireReady(subscription.scope, subscription.route);
    if (confirmed.simulatorUdid !== instance.simulatorUdid) throw new SimulatorDriverError(
      "STALE_DRIVER", "Simulator Viewer device changed during stream configuration.");
    return true;
  }

  async #configureMjpeg(instance: PublicSimulatorInstance,
    subscription: FrameSubscription, profile = subscription.mjpegProfile,
    signal: AbortSignal | null | undefined = subscription.controller.signal): Promise<void> {
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
      if (signal?.aborted) return;
      if (configuration.uncertain) throw new SimulatorViewerFrameError(
        "PROFILE_UNCERTAIN", "The previous MJPEG profile outcome is unknown; restart the Viewer driver.");
      try {
        await this.#driver.configureMjpegProfile(instance, profile, signal ?? undefined);
      } catch (error) {
        if (!signal?.aborted) configuration.uncertain = true;
        throw error;
      }
    });
    configuration.tail = current.catch(() => undefined);
    await current;
  }

  #frame(subscription: FrameSubscription, frame: SimulatorMjpegFrame): SimulatorViewerFrameEvent {
    return { kind: "frame", sequence: subscription.sequence, receivedAt: frame.receivedAt,
      bytes: frame.bytes, nativeRoute: subscription.nativeRoute };
  }

  #h264Frame(subscription: FrameSubscription, frame: SimulatorNativeH264Frame): SimulatorViewerFrameEvent {
    return { kind: "h264", sequence: subscription.sequence, receivedAt: frame.receivedAt, bytes: frame.bytes,
      width: frame.width, height: frame.height, timestampMicros: frame.timestampMicros,
      keyFrame: frame.keyFrame, format: frame.format, nativeRoute: subscription.nativeRoute };
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

function sameNativeProfile(left: SimulatorNativeH264Profile,
  right: SimulatorNativeH264Profile): boolean {
  return left.framesPerSecond === right.framesPerSecond &&
    left.scalingPercent === right.scalingPercent && left.orientation === right.orientation;
}

function freshSubscription(subscription: FrameSubscription): boolean {
  if (subscription.state !== "streaming" || subscription.lastFrameAt === null) return false;
  const age = Date.now() - Date.parse(subscription.lastFrameAt);
  return Number.isFinite(age) && age >= -1_000 && age <= 3_000;
}
