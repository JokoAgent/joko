import { MobileUpdateDeviceStore } from "./mobile-update-device-store";
import {
  MobileUpdateRequestCoordinator,
  evaluateMobileBundleUpdate,
  isMobileUpdateVersion,
  parseMobileUpdateRelease,
  withMobileUpdateTimeout,
  type MobileOtaRequestClient,
  type MobileUpdateChannel,
  type MobileUpdateConfiguration,
  type MobileUpdatePlatform,
  type MobileUpdateRelease,
  type MobileUpdateRuntime,
  type MobileUpdateRuntimeInfo
} from "./mobile-update";

export type MobileUpdateManualPhase = "idle" | "checking" | "downloading" | "reloading";
export type MobileUpdateManualOutcome =
  | "up-to-date"
  | "unavailable"
  | "update-available"
  | "restart-required"
  | "reload-blocked"
  | "busy"
  | "reloading"
  | "error";
export type MobileUpdateActionError = "channel" | "configuration" | "install" | "storage";

export interface MobileUpdateControllerState {
  readonly status: "loading" | "ready" | "error";
  readonly startup: "checking" | "ready";
  readonly channel: MobileUpdateChannel;
  readonly betaEnabled: boolean;
  readonly channelSaving: boolean;
  readonly manualPhase: MobileUpdateManualPhase;
  readonly manualOutcome?: MobileUpdateManualOutcome;
  readonly pendingRestart: boolean;
  readonly running: MobileUpdateRuntimeInfo;
  readonly prompt?: MobileUpdateRelease;
  readonly forced?: MobileUpdateRelease;
  readonly forcedChecking: boolean;
  readonly forcedCheckFailed: boolean;
  readonly actionError?: MobileUpdateActionError;
  readonly authorityAvailable: boolean;
}

export interface MobileUpdateControllerOptions {
  readonly configuration?: MobileUpdateConfiguration;
  readonly configurationError?: string;
  readonly platform: MobileUpdatePlatform;
  readonly runtime: MobileUpdateRuntime;
  readonly deviceStore: MobileUpdateDeviceStore;
  readonly now?: () => number;
  readonly startupCheckTimeoutMs?: number;
  readonly startupFetchTimeoutMs?: number;
  readonly manualCheckTimeoutMs?: number;
  readonly manualFetchTimeoutMs?: number;
  readonly releaseTimeoutMs?: number;
  readonly resumeIntervalMs?: number;
}

type BundleCheckMode = "automatic" | "manual" | "resume";
type BundleCheckOutcome = "skipped" | "none" | "optional" | "forced";

const DEFAULT_STARTUP_CHECK_TIMEOUT_MS = 2_500;
const DEFAULT_STARTUP_FETCH_TIMEOUT_MS = 8_000;
const DEFAULT_MANUAL_CHECK_TIMEOUT_MS = 10_000;
const DEFAULT_MANUAL_FETCH_TIMEOUT_MS = 30_000;
const DEFAULT_RELEASE_TIMEOUT_MS = 10_000;
const DEFAULT_RESUME_INTERVAL_MS = 5 * 60_000;

/** Owns every update request so startup, resume, Settings, and channel changes cannot race. */
export class MobileUpdateController {
  #state: MobileUpdateControllerState;
  #listeners = new Set<() => void>();
  #start?: Promise<void>;
  #manual?: Promise<void>;
  #resume?: Promise<void>;
  #forcedRecheck?: Promise<void>;
  #bundleQueue: Promise<void> = Promise.resolve();
  #bundleRequests = new Map<string, Promise<unknown | null>>();
  #generation = 0;
  #forcedRevision = 0;
  #foreground = true;
  #wasBackground = false;
  #lastResumeAt: number;
  #dismissedPromptVersion?: string;
  readonly #configuration?: MobileUpdateConfiguration;
  readonly #configurationError?: string;
  readonly #platform: MobileUpdatePlatform;
  readonly #runtime: MobileUpdateRuntime;
  readonly #deviceStore: MobileUpdateDeviceStore;
  readonly #coordinator: MobileUpdateRequestCoordinator;
  readonly #now: () => number;
  readonly #startupCheckTimeoutMs: number;
  readonly #startupFetchTimeoutMs: number;
  readonly #manualCheckTimeoutMs: number;
  readonly #manualFetchTimeoutMs: number;
  readonly #releaseTimeoutMs: number;
  readonly #resumeIntervalMs: number;

  constructor(options: MobileUpdateControllerOptions) {
    this.#configuration = options.configuration;
    this.#configurationError = options.configurationError;
    this.#platform = options.platform;
    this.#runtime = options.runtime;
    this.#deviceStore = options.deviceStore;
    this.#coordinator = new MobileUpdateRequestCoordinator(options.runtime);
    this.#now = options.now ?? Date.now;
    this.#startupCheckTimeoutMs = options.startupCheckTimeoutMs ?? DEFAULT_STARTUP_CHECK_TIMEOUT_MS;
    this.#startupFetchTimeoutMs = options.startupFetchTimeoutMs ?? DEFAULT_STARTUP_FETCH_TIMEOUT_MS;
    this.#manualCheckTimeoutMs = options.manualCheckTimeoutMs ?? DEFAULT_MANUAL_CHECK_TIMEOUT_MS;
    this.#manualFetchTimeoutMs = options.manualFetchTimeoutMs ?? DEFAULT_MANUAL_FETCH_TIMEOUT_MS;
    this.#releaseTimeoutMs = options.releaseTimeoutMs ?? DEFAULT_RELEASE_TIMEOUT_MS;
    this.#resumeIntervalMs = options.resumeIntervalMs ?? DEFAULT_RESUME_INTERVAL_MS;
    this.#lastResumeAt = this.#now();
    this.#state = Object.freeze({
      status: "loading",
      startup: "checking",
      channel: "stable",
      betaEnabled: options.configuration?.betaEnabled ?? false,
      channelSaving: false,
      manualPhase: "idle",
      pendingRestart: false,
      running: options.runtime.info,
      forcedChecking: false,
      forcedCheckFailed: false,
      authorityAvailable: Boolean(options.configuration?.releaseFeedUrl || options.configuration?.otaEnabled)
    });
  }

  get snapshot(): MobileUpdateControllerState { return this.#state; }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  start(foreground = true): Promise<void> {
    this.#foreground = foreground;
    this.#start ??= this.#startOnce();
    return this.#start;
  }

  manualCheck(): Promise<void> {
    if (this.#manual) return this.#manual;
    const flight = this.#runManualCheck().finally(() => {
      if (this.#manual === flight) this.#manual = undefined;
    });
    this.#manual = flight;
    return flight;
  }

  async setChannel(channel: MobileUpdateChannel): Promise<void> {
    if (this.#state.status !== "ready" || this.#state.channelSaving || channel === this.#state.channel) return;
    if (channel === "beta" && !this.#state.betaEnabled) throw new Error("Beta mobile updates are unavailable.");
    if (this.#effectiveOtaEnabled() && this.#coordinator.busy) {
      this.#patch({ actionError: "channel" });
      throw new Error("A mobile update request is still finishing.");
    }
    const previous = this.#state.channel;
    const generation = ++this.#generation;
    this.#patch({ channelSaving: true, actionError: undefined, prompt: undefined, manualOutcome: undefined });
    try {
      await this.#deviceStore.setChannel(channel);
      if (this.#effectiveOtaEnabled()) await this.#coordinator.configure(channel);
      if (generation !== this.#generation) return;
      this.#dismissedPromptVersion = undefined;
      this.#patch({ channel, channelSaving: false });
    } catch (cause) {
      let storageRestored = true;
      try { await this.#deviceStore.setChannel(previous); }
      catch { storageRestored = false; }
      if (this.#effectiveOtaEnabled()) await this.#coordinator.configure(previous).catch(() => undefined);
      if (generation === this.#generation) {
        this.#patch(storageRestored
          ? { channel: previous, channelSaving: false, actionError: "channel" }
          : {
              status: "error",
              channel: this.#deviceStore.snapshot.channel,
              channelSaving: false,
              actionError: "storage"
            });
      }
      throw cause;
    }
  }

  dismissPrompt(): void {
    if (!this.#state.prompt) return;
    this.#dismissedPromptVersion = this.#state.prompt.version;
    this.#patch({
      prompt: undefined,
      actionError: this.#state.actionError === "install" ? undefined : this.#state.actionError
    });
  }

  async openUpdate(target: MobileUpdateRelease): Promise<void> {
    const current = this.#state.forced ?? this.#state.prompt;
    if (!current || !sameRelease(current, target)) return;
    this.#patch({ actionError: undefined });
    try {
      await this.#runtime.openUrl(current.installUrl);
    } catch (cause) {
      this.#patch({ actionError: "install" });
      throw cause;
    }
  }

  resetDeviceSettings(): Promise<void> {
    const generation = ++this.#generation;
    this.#patch({ status: "loading", channelSaving: true, actionError: undefined });
    return this.#deviceStore.reset().then(async () => {
      if (this.#effectiveOtaEnabled()) await this.#coordinator.configure("stable");
      if (generation !== this.#generation) return;
      this.#patch({
        status: "ready",
        channel: "stable",
        channelSaving: false,
        actionError: this.#configurationError ? "configuration" : undefined
      });
    }).catch((cause) => {
      if (generation === this.#generation) {
        this.#patch({ status: "error", channelSaving: false, actionError: "storage" });
      }
      throw cause;
    });
  }

  handleAppStateChange(next: string): Promise<void> | undefined {
    if (next === "background") {
      this.#foreground = false;
      this.#wasBackground = true;
      return undefined;
    }
    if (next !== "active") {
      this.#foreground = false;
      return undefined;
    }
    this.#foreground = true;
    if (!this.#wasBackground) return undefined;
    this.#wasBackground = false;
    if (this.#state.forced) return this.recheckForced();
    if (this.#now() - this.#lastResumeAt < this.#resumeIntervalMs || this.#resume) return this.#resume;
    this.#lastResumeAt = this.#now();
    const flight = this.#runResumeCheck().finally(() => {
      if (this.#resume === flight) this.#resume = undefined;
    });
    this.#resume = flight;
    return flight;
  }

  recheckForced(): Promise<void> {
    if (!this.#state.forced) return Promise.resolve();
    if (this.#forcedRecheck) return this.#forcedRecheck;
    const flight = this.#runForcedRecheck().finally(() => {
      if (this.#forcedRecheck === flight) this.#forcedRecheck = undefined;
    });
    this.#forcedRecheck = flight;
    return flight;
  }

  async #startOnce(): Promise<void> {
    let channel: MobileUpdateChannel;
    try {
      await this.#deviceStore.hydrate();
      channel = this.#deviceStore.snapshot.channel;
      if (channel === "beta" && !this.#configuration?.betaEnabled) {
        await this.#deviceStore.setChannel("stable");
        channel = "stable";
      }
      await this.#deviceStore.clearReloadIfLaunched(this.#runtime.info.updateId);
      this.#patch({
        status: "ready",
        channel,
        ...(this.#configurationError ? { actionError: "configuration" as const } : {})
      });
    } catch {
      this.#patch({ status: "error", actionError: "storage", startup: "ready" });
      return;
    }
    if (this.#effectiveOtaEnabled()) {
      try {
        await this.#coordinator.configure(channel);
        await this.#runStartupOta(channel, this.#generation);
      } catch {
        this.#patch({ actionError: "configuration" });
      }
    }
    this.#patch({ startup: "ready" });
    if (this.#state.status !== "ready") return;
    const generation = this.#generation;
    if (this.#runtime.info.isEmergencyLaunch) {
      void this.#recoverEmergencyOta(this.#state.channel, generation);
    }
    void this.#checkBundle("automatic", generation).catch(() => undefined);
  }

  async #runStartupOta(channel: MobileUpdateChannel, generation: number): Promise<void> {
    if (!this.#effectiveOtaEnabled() || this.#runtime.info.isEmergencyLaunch) return;
    let timedOut = false;
    try {
      await this.#coordinator.run(channel, async (client) => {
        const check = await withMobileUpdateTimeout(client.check(), this.#startupCheckTimeoutMs);
        if (!check.isAvailable) return;
        const checkId = check.manifestId;
        if (!checkId || checkId === this.#runtime.info.updateId || this.#deviceStore.isReloadBlocked(checkId)) return;
        const fetched = await withMobileUpdateTimeout(client.fetch(), this.#startupFetchTimeoutMs);
        if (!fetched.isNew) return;
        const targetId = fetched.manifestId ?? checkId;
        if (!targetId || targetId === this.#runtime.info.updateId || this.#deviceStore.isReloadBlocked(targetId)) return;
        if (generation !== this.#generation || !this.#foreground) {
          if (generation === this.#generation) this.#patch({ pendingRestart: true });
          return;
        }
        await this.#deviceStore.recordReload(targetId);
        if (generation !== this.#generation || !this.#foreground) {
          await this.#deviceStore.cancelReload(targetId).catch(() => undefined);
          if (generation === this.#generation) this.#patch({ pendingRestart: true });
          return;
        }
        await client.reload();
      });
    } catch (cause) {
      timedOut = cause instanceof Error && cause.message.startsWith("mobile-update-timeout(");
      // Startup is deliberately fail-open. The user can retry from Settings.
    }
    if (!timedOut) await this.#coordinator.waitUntilIdle();
  }

  async #recoverEmergencyOta(channel: MobileUpdateChannel, generation: number): Promise<void> {
    if (!this.#effectiveOtaEnabled() || this.#coordinator.busy) return;
    try {
      await this.#coordinator.run(channel, async (client) => {
        const check = await withMobileUpdateTimeout(client.check(), this.#startupCheckTimeoutMs);
        if (!check.isAvailable || !check.manifestId || this.#deviceStore.isReloadBlocked(check.manifestId)) return;
        const fetched = await withMobileUpdateTimeout(client.fetch(), this.#startupFetchTimeoutMs);
        const targetId = fetched.manifestId ?? check.manifestId;
        if (fetched.isNew && targetId && !this.#deviceStore.isReloadBlocked(targetId)
          && generation === this.#generation) {
          this.#patch({ pendingRestart: true });
        }
      });
    } catch {
      // Emergency recovery is best-effort and never blocks product use.
    }
  }

  async #runManualCheck(): Promise<void> {
    if (this.#state.status !== "ready" || this.#state.channelSaving) return;
    const generation = this.#generation;
    const channel = this.#state.channel;
    this.#patch({ manualPhase: "checking", manualOutcome: undefined, actionError: undefined });
    let bundleAuthorityChecked = false;
    try {
      if (this.#canCheckBundle()) {
        const bundle = await this.#checkBundle("manual", generation);
        bundleAuthorityChecked = bundle !== "skipped";
        if (generation !== this.#generation) return;
        if (bundle === "optional" || bundle === "forced") {
          this.#patch({ manualOutcome: "update-available" });
          return;
        }
      }
      if (!this.#effectiveOtaEnabled()) {
        this.#patch({ manualOutcome: bundleAuthorityChecked ? "up-to-date" : "unavailable" });
        return;
      }
      if (this.#coordinator.busy) {
        this.#patch({ manualOutcome: "busy" });
        return;
      }
      const outcome = await this.#coordinator.run(channel, (client) => this.#manualOta(client, generation));
      if (generation === this.#generation) this.#patch({ manualOutcome: outcome });
    } catch {
      if (generation === this.#generation) this.#patch({ manualOutcome: "error" });
    } finally {
      if (generation === this.#generation) this.#patch({ manualPhase: "idle" });
    }
  }

  async #manualOta(client: MobileOtaRequestClient, generation: number): Promise<MobileUpdateManualOutcome> {
    const check = await withMobileUpdateTimeout(client.check(), this.#manualCheckTimeoutMs);
    if (!check.isAvailable) return "up-to-date";
    const checkId = check.manifestId;
    if (!checkId) return "error";
    if (checkId === this.#runtime.info.updateId) return "up-to-date";
    if (this.#deviceStore.isReloadBlocked(checkId)) return "reload-blocked";
    if (generation !== this.#generation) return "unavailable";
    this.#patch({ manualPhase: "downloading" });
    const fetched = await withMobileUpdateTimeout(client.fetch(), this.#manualFetchTimeoutMs);
    if (!fetched.isNew) return "up-to-date";
    const targetId = fetched.manifestId ?? checkId;
    if (!targetId) return "error";
    if (this.#deviceStore.isReloadBlocked(targetId)) return "reload-blocked";
    if (generation !== this.#generation || !this.#foreground || this.#runtime.info.isEmergencyLaunch) {
      if (generation === this.#generation) this.#patch({ pendingRestart: true });
      return "restart-required";
    }
    await this.#deviceStore.recordReload(targetId);
    if (generation !== this.#generation || !this.#foreground) {
      await this.#deviceStore.cancelReload(targetId).catch(() => undefined);
      if (generation === this.#generation) this.#patch({ pendingRestart: true });
      return "restart-required";
    }
    this.#patch({ manualPhase: "reloading" });
    try {
      await client.reload();
      return "reloading";
    } catch (cause) {
      if (!this.#foreground || this.#runtime.info.isEmergencyLaunch) {
        this.#patch({ pendingRestart: true });
        return "restart-required";
      }
      throw cause;
    }
  }

  async #runResumeCheck(): Promise<void> {
    if (this.#state.status !== "ready" || this.#state.channelSaving) return;
    const generation = this.#generation;
    const channel = this.#state.channel;
    const work: Promise<unknown>[] = [];
    if (this.#canCheckBundle()) work.push(this.#checkBundle("resume", generation));
    if (this.#effectiveOtaEnabled() && !this.#coordinator.busy) {
      work.push(this.#coordinator.run(channel, async (client) => {
        const check = await withMobileUpdateTimeout(client.check(), this.#manualCheckTimeoutMs);
        if (!check.isAvailable || !check.manifestId || check.manifestId === this.#runtime.info.updateId
          || this.#deviceStore.isReloadBlocked(check.manifestId)) return;
        const fetched = await withMobileUpdateTimeout(client.fetch(), this.#manualFetchTimeoutMs);
        const targetId = fetched.manifestId ?? check.manifestId;
        if (fetched.isNew && targetId && !this.#deviceStore.isReloadBlocked(targetId)
          && generation === this.#generation) {
          this.#patch({ pendingRestart: true });
        }
      }));
    }
    await Promise.allSettled(work);
  }

  async #checkBundle(mode: BundleCheckMode, generation: number): Promise<BundleCheckOutcome> {
    if (!this.#canCheckBundle()) return "skipped";
    const configuration = this.#configuration!;
    const platform = this.#platform as "android" | "ios";
    if (!isMobileUpdateVersion(this.#runtime.info.appVersion)
      || !validRuntimeVersion(this.#runtime.info.runtimeVersion)) {
      throw new Error("The installed mobile version cannot be verified.");
    }
    const value = await this.#requestBundleRelease(
      configuration.releaseFeedUrl!, platform, this.#state.channel, generation
    );
    if (generation !== this.#generation) return "skipped";
    if (value === null) return "none";
    const release = parseMobileUpdateRelease(value);
    const evaluation = evaluateMobileBundleUpdate({
      currentVersion: this.#runtime.info.appVersion,
      currentRuntimeVersion: this.#runtime.info.runtimeVersion,
      release
    });
    if (!evaluation.needsUpdate || !evaluation.target) return "none";
    if (evaluation.forced) {
      this.#enterForced(evaluation.target);
      return "forced";
    }
    if (mode === "resume" || mode === "automatic" && (!this.#foreground
      || this.#dismissedPromptVersion === evaluation.target.version)) return "optional";
    this.#patch({ prompt: evaluation.target });
    return "optional";
  }

  async #runForcedRecheck(): Promise<void> {
    const held = this.#state.forced;
    if (!held || !this.#canCheckBundle()) {
      this.#patch({ forcedCheckFailed: true });
      return;
    }
    const expectedRevision = this.#forcedRevision;
    const generation = this.#generation;
    this.#patch({ forcedChecking: true, forcedCheckFailed: false, actionError: undefined });
    try {
      if (!isMobileUpdateVersion(this.#runtime.info.appVersion)
        || !validRuntimeVersion(this.#runtime.info.runtimeVersion)) throw new Error("version-unavailable");
      const value = await this.#requestBundleRelease(
        this.#configuration!.releaseFeedUrl!,
        this.#platform as "android" | "ios",
        this.#state.channel,
        generation
      );
      if (generation !== this.#generation || expectedRevision !== this.#forcedRevision) return;
      if (value === null) {
        this.#clearForced(expectedRevision);
        return;
      }
      const release = parseMobileUpdateRelease(value);
      if (compareReleaseVersions(release.version, held.version) < 0) throw new Error("stale-release");
      const evaluation = evaluateMobileBundleUpdate({
        currentVersion: this.#runtime.info.appVersion,
        currentRuntimeVersion: this.#runtime.info.runtimeVersion,
        release
      });
      if (evaluation.forced && evaluation.target) {
        this.#enterForced(evaluation.target, expectedRevision);
        return;
      }
      this.#clearForced(expectedRevision);
      if (evaluation.needsUpdate && evaluation.target) this.#patch({ prompt: evaluation.target });
    } catch {
      if (generation === this.#generation && expectedRevision === this.#forcedRevision) {
        this.#patch({ forcedCheckFailed: true });
      }
    } finally {
      if (generation === this.#generation) this.#patch({ forcedChecking: false });
    }
  }

  #enterForced(target: MobileUpdateRelease, expectedRevision?: number): void {
    if (expectedRevision !== undefined && expectedRevision !== this.#forcedRevision) return;
    if (sameRelease(this.#state.forced, target)) {
      if (expectedRevision === undefined) this.#forcedRevision += 1;
      return;
    }
    this.#forcedRevision += 1;
    this.#patch({ forced: target, prompt: undefined, forcedCheckFailed: false });
  }

  #clearForced(expectedRevision: number): void {
    if (expectedRevision !== this.#forcedRevision || !this.#state.forced) return;
    this.#forcedRevision += 1;
    this.#patch({ forced: undefined, forcedCheckFailed: false });
  }

  #effectiveOtaEnabled(): boolean {
    return Boolean(this.#configuration?.otaEnabled && this.#runtime.info.isEnabled);
  }

  #requestBundleRelease(
    feedUrl: string,
    platform: "android" | "ios",
    channel: MobileUpdateChannel,
    generation: number
  ): Promise<unknown | null> {
    const key = `${generation}\u001f${channel}`;
    const existing = this.#bundleRequests.get(key);
    if (existing) return existing;
    const request = this.#bundleQueue.then(() => this.#runtime.fetchRelease(
      feedUrl, platform, channel, this.#releaseTimeoutMs
    ));
    this.#bundleQueue = request.then(() => undefined, () => undefined);
    const tracked = request.finally(() => {
      if (this.#bundleRequests.get(key) === tracked) this.#bundleRequests.delete(key);
    });
    this.#bundleRequests.set(key, tracked);
    return tracked;
  }

  #canCheckBundle(): boolean {
    return Boolean(this.#configuration?.releaseFeedUrl
      && (this.#platform === "android" || this.#platform === "ios"));
  }

  #patch(patch: Partial<MobileUpdateControllerState>): void {
    const next = Object.freeze({ ...this.#state, ...patch });
    if (sameState(this.#state, next)) return;
    this.#state = next;
    for (const listener of [...this.#listeners]) {
      try { listener(); }
      catch { /* A subscriber cannot prevent other subscribers from receiving the state. */ }
    }
  }
}

function validRuntimeVersion(value: string | undefined): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 256
    && value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value);
}

function compareReleaseVersions(left: string, right: string): number {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index]! > b[index]! ? 1 : -1;
  }
  return 0;
}

function sameRelease(left: MobileUpdateRelease | undefined, right: MobileUpdateRelease | undefined): boolean {
  return left === right || Boolean(left && right && left.version === right.version
    && left.runtimeVersion === right.runtimeVersion && left.installUrl === right.installUrl
    && left.releaseNotes === right.releaseNotes && left.minVersion === right.minVersion);
}

function sameState(left: MobileUpdateControllerState, right: MobileUpdateControllerState): boolean {
  return left.status === right.status && left.startup === right.startup && left.channel === right.channel
    && left.betaEnabled === right.betaEnabled && left.channelSaving === right.channelSaving
    && left.manualPhase === right.manualPhase && left.manualOutcome === right.manualOutcome
    && left.pendingRestart === right.pendingRestart && left.running === right.running
    && sameRelease(left.prompt, right.prompt) && sameRelease(left.forced, right.forced)
    && left.forcedChecking === right.forcedChecking && left.forcedCheckFailed === right.forcedCheckFailed
    && left.actionError === right.actionError && left.authorityAvailable === right.authorityAvailable;
}
