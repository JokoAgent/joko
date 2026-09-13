import { existsSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { basename } from "node:path";

import { AdbCliAdapter, type AndroidAdbAdapter } from "./adb-adapter.js";
import {
  BoundedAndroidCommandRunner,
  type AndroidCommandRunner
} from "./process-runner.js";
import { redactAndroidOutput } from "./redaction.js";
import {
  AndroidAdbResolver,
  buildAndroidAdbCandidates,
  type AndroidAdbPreparer
} from "./resolver.js";
import {
  AndroidRuntimeError,
  type AndroidAdbPathSource,
  type AndroidConnectedDevice,
  type AndroidDeviceSnapshot,
  type AndroidHostPlatform,
  type AndroidInstallOptions,
  type AndroidKey,
  type AndroidPoint,
  type AndroidRuntimeActivityState,
  type AndroidRuntimeIssue,
  type AndroidRuntimeStatus,
  type AndroidScreenState
} from "./types.js";

const DEFAULT_ADB_SERVER_PORT = 5037;
const DEFAULT_SNAPSHOT_MAXIMUM_AGE_MS = 5 * 60_000;

export interface AndroidRuntimeOptions {
  readonly platform?: NodeJS.Platform;
  readonly architecture?: string;
  readonly executablePath?: string;
  readonly pathSource?: AndroidAdbPathSource;
  readonly environment?: NodeJS.ProcessEnv;
  readonly homeDirectory?: string;
  readonly artifactRoots?: readonly string[];
  readonly defaultDeviceSerial?: string;
  readonly runner?: AndroidCommandRunner;
  readonly adapter?: AndroidAdbAdapter;
  readonly bundledExecutablePaths?: readonly string[];
  readonly preparedExecutablePath?: string;
  readonly preparer?: AndroidAdbPreparer;
  readonly pathExists?: (path: string) => boolean;
  readonly serverPort?: number;
  readonly portProbe?: (port: number) => Promise<boolean>;
  readonly snapshotMaximumAgeMs?: number;
  readonly coldStartTimeoutMs?: number;
  readonly coldStartPollIntervalMs?: number;
  readonly delay?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  readonly now?: () => number;
  readonly onActivityStateChange?: (state: AndroidRuntimeActivityState) => void;
}

export interface AndroidSessionInput {
  readonly sessionId: string;
  readonly deviceSerial?: string;
  readonly signal?: AbortSignal;
}

export interface AndroidTapInput extends AndroidSessionInput {
  readonly elementIndex?: number;
  readonly point?: AndroidPoint;
}

export interface AndroidSwipeInput extends AndroidSessionInput {
  readonly start: AndroidPoint;
  readonly end: AndroidPoint;
  readonly durationMs?: number;
}

export interface AndroidInputTextInput extends AndroidSessionInput {
  readonly text: string;
}

export interface AndroidPressKeyInput extends AndroidSessionInput {
  readonly key: AndroidKey;
}

export interface AndroidLaunchAppInput extends AndroidSessionInput {
  readonly packageName: string;
  readonly activity?: string;
}

export interface AndroidInstallArtifactInput extends AndroidSessionInput {
  readonly artifactPath: string;
  readonly options?: AndroidInstallOptions;
}

export interface AndroidRuntimeDescriptor {
  readonly executablePath: string;
  readonly pathSource: AndroidAdbPathSource;
  readonly platform: AndroidHostPlatform;
  readonly architecture: string;
}

export interface AndroidRuntimeProbeOptions {
  readonly fresh?: boolean;
  readonly allowPreparation?: boolean;
  readonly signal?: AbortSignal;
}

interface CachedSnapshot {
  readonly snapshot: AndroidDeviceSnapshot;
  readonly capturedAt: number;
}

export class AndroidAutomationRuntime {
  readonly #platform: AndroidHostPlatform;
  readonly #architecture: string;
  #executablePath: string;
  #pathSource: AndroidAdbPathSource;
  #adapter: AndroidAdbAdapter | undefined;
  readonly #resolver: AndroidAdbResolver | undefined;
  readonly #defaultDeviceSerial: string | undefined;
  readonly #serverPort: number;
  readonly #portProbe: (port: number) => Promise<boolean>;
  readonly #snapshotMaximumAgeMs: number;
  readonly #coldStartTimeoutMs: number;
  readonly #coldStartPollIntervalMs: number;
  readonly #delay: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  readonly #now: () => number;
  readonly #redactRoots: readonly string[];
  readonly #onActivityStateChange: ((state: AndroidRuntimeActivityState) => void) | undefined;
  readonly #snapshots = new Map<string, CachedSnapshot>();
  readonly #deviceTails = new Map<string, Promise<void>>();
  #deviceQuery: Promise<readonly AndroidConnectedDevice[]> | undefined;
  #ownsServer = false;
  #serverOwner: AndroidAdbAdapter | undefined;
  #disposed = false;
  #checkingOperations = 0;
  #preparing = false;
  #lastEmittedActivity: AndroidRuntimeActivityState = "idle";

  constructor(options: AndroidRuntimeOptions = {}) {
    const platformSource = options.platform ?? process.platform;
    this.#platform = normalizeAndroidPlatform(platformSource);
    this.#architecture = options.architecture ?? process.arch;
    const homeDirectory = options.homeDirectory ?? homedir();
    const initialCandidates = buildAndroidAdbCandidates({
      platform: platformSource,
      environment: options.environment ?? process.env,
      homeDirectory,
      customPath: options.executablePath,
      bundledPaths: options.bundledExecutablePaths,
      preparedPath: options.preparedExecutablePath,
      pathExists: options.pathExists ?? existsSync
    });
    const initial = initialCandidates[0] ?? {
      executablePath: platformSource === "win32" ? "adb.exe" : "adb",
      pathSource: "path" as const
    };
    this.#executablePath = initial.executablePath;
    this.#pathSource = options.pathSource ?? initial.pathSource;
    this.#defaultDeviceSerial = options.defaultDeviceSerial === undefined
      ? undefined
      : validateConfiguredSerial(options.defaultDeviceSerial);
    this.#serverPort = boundedServerPort(
      options.serverPort ?? environmentServerPort((options.environment ?? process.env)["ANDROID_ADB_SERVER_PORT"])
    );
    this.#portProbe = options.portProbe ?? isLocalPortListening;
    this.#snapshotMaximumAgeMs = boundedSnapshotAge(
      options.snapshotMaximumAgeMs ?? DEFAULT_SNAPSHOT_MAXIMUM_AGE_MS
    );
    this.#coldStartTimeoutMs = boundedColdStartTimeout(options.coldStartTimeoutMs ?? 15_000);
    this.#coldStartPollIntervalMs = boundedPollInterval(options.coldStartPollIntervalMs ?? 250);
    this.#delay = options.delay ?? abortableDelay;
    this.#now = options.now ?? Date.now;
    this.#redactRoots = [homeDirectory, ...(options.artifactRoots ?? [])];
    this.#onActivityStateChange = options.onActivityStateChange;
    const runner = options.runner ?? new BoundedAndroidCommandRunner({
      platform: platformSource,
      environment: options.environment ?? process.env,
      redactRoots: this.#redactRoots
    });
    this.#adapter = options.adapter;
    this.#resolver = options.adapter === undefined
      ? new AndroidAdbResolver({
          platform: platformSource,
          environment: options.environment ?? process.env,
          homeDirectory,
          customPath: options.executablePath,
          bundledPaths: options.bundledExecutablePaths,
          preparedPath: options.preparedExecutablePath,
          pathExists: options.pathExists ?? existsSync,
          adapterFactory: (candidate) => new AdbCliAdapter({
            executablePath: candidate.executablePath,
            runner,
            artifactRoots: options.artifactRoots,
            now: this.#now
          }),
          preparer: options.preparer,
          redactRoots: this.#redactRoots,
          onPreparingChange: (preparing) => this.#setPreparing(preparing)
        })
      : undefined;
  }

  descriptor(): AndroidRuntimeDescriptor {
    return {
      executablePath: redactExecutablePath(this.#executablePath, this.#redactRoots),
      pathSource: this.#pathSource,
      platform: this.#platform,
      architecture: this.#architecture
    };
  }

  get managedServer(): boolean {
    return this.#ownsServer;
  }

  get cachedSnapshotCount(): number {
    return this.#snapshots.size;
  }

  activityState(): AndroidRuntimeActivityState {
    return this.#preparing ? "preparing" : this.#checkingOperations > 0 ? "checking" : "idle";
  }

  async status(signal?: AbortSignal): Promise<AndroidRuntimeStatus> {
    return this.#checkedStatus(signal, true);
  }

  /** Resolves (and, when necessary, prepares) ADB without listing devices. */
  async prepare(signal?: AbortSignal): Promise<void> {
    this.#assertSupported();
    if (this.#resolver !== undefined) {
      await this.#useAdapter(signal, true);
      return;
    }
    const adapter = await this.#useAdapter(signal, true);
    await adapter.probe(signal);
  }

  probe(options: AndroidRuntimeProbeOptions = {}): Promise<AndroidRuntimeStatus> {
    if (options.fresh === true && this.#resolver !== undefined) {
      this.#resolver.invalidate();
      this.#adapter = undefined;
      this.#snapshots.clear();
    }
    return this.#checkedStatus(options.signal, options.allowPreparation !== false);
  }

  async #checkedStatus(
    signal: AbortSignal | undefined,
    allowPreparation: boolean
  ): Promise<AndroidRuntimeStatus> {
    this.#beginChecking();
    let status: AndroidRuntimeStatus;
    try {
      status = await this.#statusDuringCheck(signal, allowPreparation);
    } finally {
      this.#endChecking();
    }
    return { ...status, activityState: this.activityState() };
  }

  async #statusDuringCheck(
    signal: AbortSignal | undefined,
    allowPreparation: boolean
  ): Promise<AndroidRuntimeStatus> {
    this.#assertUsable();
    if (this.#platform === "unsupported") return this.#unsupportedStatus();
    let version: string;
    try {
      const adapter = await this.#useAdapter(signal, allowPreparation);
      version = await adapter.probe(signal);
    } catch (error) {
      if (isAbortError(error)) throw error;
      return {
        supported: true,
        platform: this.#platform,
        architecture: this.#architecture,
        installation: {
          state: "missing",
          pathSource: this.#pathSource,
          ...(this.#resolver === undefined ? {} : {
            preparation: redactPreparation(this.#resolver.preparationState(), this.#redactRoots)
          })
        },
        server: {
          state: await this.#serverState(),
          port: this.#serverPort,
          managedByRuntime: this.#ownsServer
        },
        devices: [],
        ...(this.#defaultDeviceSerial === undefined ? {} : {
          configuredDefaultDeviceSerial: this.#defaultDeviceSerial
        }),
        issue: "adb_not_found",
        error: safeError(error, this.#redactRoots),
        activityState: this.activityState()
      };
    }

    let devices: readonly AndroidConnectedDevice[] = [];
    let listError: string | undefined;
    try {
      devices = await this.listDevices(signal);
    } catch (error) {
      if (isAbortError(error)) throw error;
      listError = safeError(error, this.#redactRoots);
    }
    const selection = classifyDevices(devices, this.#defaultDeviceSerial);
    return {
      supported: true,
      platform: this.#platform,
      architecture: this.#architecture,
      installation: {
        state: "installed",
        executablePath: redactExecutablePath(this.#executablePath, this.#redactRoots),
        pathSource: this.#pathSource,
        version,
        ...(this.#resolver === undefined ? {} : {
          preparation: redactPreparation(this.#resolver.preparationState(), this.#redactRoots)
        })
      },
      server: {
        state: await this.#serverState(),
        port: this.#serverPort,
        managedByRuntime: this.#ownsServer
      },
      devices,
      ...(this.#defaultDeviceSerial === undefined ? {} : {
        configuredDefaultDeviceSerial: this.#defaultDeviceSerial
      }),
      ...(selection.serial === undefined ? {} : { selectedDeviceSerial: selection.serial }),
      ...(selection.issue === undefined ? {} : { issue: selection.issue }),
      ...(listError === undefined ? {} : { error: listError }),
      activityState: this.activityState()
    };
  }

  async listDevices(signal?: AbortSignal): Promise<readonly AndroidConnectedDevice[]> {
    this.#assertSupported();
    if (signal?.aborted === true) throw abortError();
    const existing = this.#deviceQuery;
    if (existing !== undefined) return withSignal(existing, signal);
    const query = this.#listDevicesNow(signal);
    this.#deviceQuery = query;
    try {
      return await query;
    } finally {
      if (this.#deviceQuery === query) this.#deviceQuery = undefined;
    }
  }

  async startServer(signal?: AbortSignal): Promise<{ readonly managedByRuntime: boolean }> {
    this.#assertSupported();
    const existed = await this.#portProbe(this.#serverPort).catch(() => false);
    const adapter = await this.#useAdapter(signal);
    await adapter.startServer(signal);
    const running = await this.#portProbe(this.#serverPort).catch(() => false);
    if (!existed && running && canOwnAdbServer(this.#pathSource)) {
      this.#ownsServer = true;
      this.#serverOwner = adapter;
    }
    return { managedByRuntime: this.#ownsServer };
  }

  async stopManagedServer(signal?: AbortSignal): Promise<void> {
    this.#assertSupported();
    if (!this.#ownsServer) {
      throw new AndroidRuntimeError(
        "server_not_owned",
        "ADB server was already running before this runtime and will not be stopped."
      );
    }
    const owner = this.#serverOwner;
    if (owner === undefined) throw new AndroidRuntimeError("server_not_owned", "ADB server ownership is unavailable.");
    await owner.killServer(signal);
    this.#ownsServer = false;
    this.#serverOwner = undefined;
  }

  async connectDevice(
    endpoint: string,
    signal?: AbortSignal
  ): Promise<{ readonly endpoint: string; readonly output: string; readonly devices: readonly AndroidConnectedDevice[] }> {
    this.#assertSupported();
    const existed = await this.#portProbe(this.#serverPort).catch(() => false);
    const adapter = await this.#useAdapter(signal);
    const connected = await adapter.connect(endpoint, signal);
    const running = await this.#portProbe(this.#serverPort).catch(() => false);
    if (!existed && running && canOwnAdbServer(this.#pathSource)) {
      this.#ownsServer = true;
      this.#serverOwner = adapter;
    }
    const devices = await this.listDevices(signal);
    return { ...connected, devices };
  }

  async disconnectDevice(
    endpoint: string,
    signal?: AbortSignal
  ): Promise<{ readonly endpoint: string; readonly output: string; readonly devices: readonly AndroidConnectedDevice[] }> {
    this.#assertSupported();
    const adapter = await this.#useAdapter(signal);
    const disconnected = await adapter.disconnect(endpoint, signal);
    const devices = await this.listDevices(signal);
    this.#dropSnapshotsForSerial(disconnected.endpoint);
    return { ...disconnected, devices };
  }

  async snapshot(input: AndroidSessionInput): Promise<AndroidDeviceSnapshot> {
    const sessionId = validateSessionId(input.sessionId);
    const device = await this.#targetDevice(input.deviceSerial, input.signal);
    return this.#enqueueDevice(device.serial, async () => {
      const adapter = await this.#useAdapter(input.signal);
      const snapshot = await adapter.snapshot(device.serial, input.signal);
      this.#snapshots.set(snapshotKey(sessionId, device.serial), {
        snapshot,
        capturedAt: this.#now()
      });
      return snapshot;
    });
  }

  async tap(input: AndroidTapInput): Promise<{
    readonly deviceSerial: string;
    readonly point: AndroidPoint;
  }> {
    const sessionId = validateSessionId(input.sessionId);
    const device = await this.#targetDevice(input.deviceSerial, input.signal);
    const hasIndex = input.elementIndex !== undefined;
    const hasPoint = input.point !== undefined;
    if (hasIndex === hasPoint) {
      throw new AndroidRuntimeError("invalid_coordinate", "Tap requires exactly one node index or one coordinate.");
    }
    return this.#enqueueDevice(device.serial, async () => {
      let point: AndroidPoint;
      let screen: AndroidScreenState;
      if (input.elementIndex !== undefined) {
        if (!Number.isSafeInteger(input.elementIndex) || input.elementIndex < 1) {
          throw new AndroidRuntimeError("invalid_node", "Android node index is invalid.");
        }
        const cached = this.#freshSnapshot(sessionId, device.serial);
        if (cached === undefined) {
          throw new AndroidRuntimeError(
            "invalid_node",
            "No fresh device snapshot is available for this session."
          );
        }
        const node = cached.snapshot.nodes.find((candidate) => candidate.index === input.elementIndex);
        if (node === undefined) throw new AndroidRuntimeError("invalid_node", "Android node index was not found.");
        point = {
          x: Math.floor((node.bounds.x1 + node.bounds.x2) / 2),
          y: Math.floor((node.bounds.y1 + node.bounds.y2) / 2)
        };
        screen = cached.snapshot.screen;
      } else {
        point = input.point as AndroidPoint;
        const cached = this.#freshSnapshot(sessionId, device.serial);
        if (cached === undefined) {
          const adapter = await this.#useAdapter(input.signal);
          const snapshot = await adapter.snapshot(device.serial, input.signal);
          this.#snapshots.set(snapshotKey(sessionId, device.serial), { snapshot, capturedAt: this.#now() });
          screen = snapshot.screen;
        } else {
          screen = cached.snapshot.screen;
        }
      }
      assertPointInScreen(point, screen);
      const adapter = await this.#useAdapter(input.signal);
      await adapter.tap(device.serial, point, input.signal);
      this.#snapshots.delete(snapshotKey(sessionId, device.serial));
      return { deviceSerial: device.serial, point };
    });
  }

  async swipe(input: AndroidSwipeInput): Promise<{
    readonly deviceSerial: string;
    readonly start: AndroidPoint;
    readonly end: AndroidPoint;
    readonly durationMs: number;
  }> {
    const sessionId = validateSessionId(input.sessionId);
    const device = await this.#targetDevice(input.deviceSerial, input.signal);
    const durationMs = input.durationMs ?? 300;
    if (!Number.isSafeInteger(durationMs) || durationMs < 0 || durationMs > 60_000) {
      throw new AndroidRuntimeError("invalid_coordinate", "Swipe duration must be between zero and 60 seconds.");
    }
    return this.#enqueueDevice(device.serial, async () => {
      const screen = await this.#screenForAction(sessionId, device.serial, input.signal);
      assertPointInScreen(input.start, screen);
      assertPointInScreen(input.end, screen);
      const adapter = await this.#useAdapter(input.signal);
      await adapter.swipe(device.serial, input.start, input.end, durationMs, input.signal);
      this.#snapshots.delete(snapshotKey(sessionId, device.serial));
      return { deviceSerial: device.serial, start: input.start, end: input.end, durationMs };
    });
  }

  async inputText(input: AndroidInputTextInput): Promise<{
    readonly deviceSerial: string;
    readonly characterCount: number;
  }> {
    const sessionId = validateSessionId(input.sessionId);
    const device = await this.#targetDevice(input.deviceSerial, input.signal);
    return this.#enqueueDevice(device.serial, async () => {
      const adapter = await this.#useAdapter(input.signal);
      await adapter.inputText(device.serial, input.text, input.signal);
      this.#snapshots.delete(snapshotKey(sessionId, device.serial));
      return { deviceSerial: device.serial, characterCount: Array.from(input.text).length };
    });
  }

  async pressKey(input: AndroidPressKeyInput): Promise<{
    readonly deviceSerial: string;
    readonly key: AndroidKey;
    readonly keyCode: number;
  }> {
    const sessionId = validateSessionId(input.sessionId);
    const device = await this.#targetDevice(input.deviceSerial, input.signal);
    return this.#enqueueDevice(device.serial, async () => {
      const adapter = await this.#useAdapter(input.signal);
      const keyCode = await adapter.pressKey(device.serial, input.key, input.signal);
      this.#snapshots.delete(snapshotKey(sessionId, device.serial));
      return { deviceSerial: device.serial, key: input.key, keyCode };
    });
  }

  async launchApp(input: AndroidLaunchAppInput): Promise<{
    readonly deviceSerial: string;
    readonly packageName: string;
    readonly activity?: string;
    readonly output: string;
  }> {
    const sessionId = validateSessionId(input.sessionId);
    const device = await this.#targetDevice(input.deviceSerial, input.signal);
    return this.#enqueueDevice(device.serial, async () => {
      const adapter = await this.#useAdapter(input.signal);
      const output = await adapter.launchApp(
        device.serial,
        input.packageName,
        input.activity,
        input.signal
      );
      this.#snapshots.delete(snapshotKey(sessionId, device.serial));
      return {
        deviceSerial: device.serial,
        packageName: input.packageName,
        ...(input.activity === undefined ? {} : { activity: input.activity }),
        output
      };
    });
  }

  async installArtifact(input: AndroidInstallArtifactInput): Promise<{
    readonly deviceSerial: string;
    readonly installed: true;
    readonly output: string;
  }> {
    const sessionId = validateSessionId(input.sessionId);
    const device = await this.#targetDevice(input.deviceSerial, input.signal);
    return this.#enqueueDevice(device.serial, async () => {
      const adapter = await this.#useAdapter(input.signal);
      const output = await adapter.installArtifact(
        device.serial,
        input.artifactPath,
        input.options,
        input.signal
      );
      this.#snapshots.delete(snapshotKey(sessionId, device.serial));
      return { deviceSerial: device.serial, installed: true, output };
    });
  }

  closeSession(sessionId: string): void {
    const safeSessionId = validateSessionId(sessionId);
    const prefix = `${safeSessionId}\0`;
    for (const key of this.#snapshots.keys()) {
      if (key.startsWith(prefix)) this.#snapshots.delete(key);
    }
  }

  async dispose(signal?: AbortSignal): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#snapshots.clear();
    if (!this.#ownsServer) return;
    try {
      await this.#serverOwner?.killServer(signal);
    } finally {
      this.#ownsServer = false;
      this.#serverOwner = undefined;
    }
  }

  async #listDevicesNow(signal?: AbortSignal): Promise<readonly AndroidConnectedDevice[]> {
    const existed = await this.#portProbe(this.#serverPort).catch(() => false);
    const adapter = await this.#useAdapter(signal);
    let devices: readonly AndroidConnectedDevice[];
    try {
      devices = await adapter.listDevices(signal);
    } catch (error) {
      if (!isTransientServerStartupError(error)) throw error;
      const deadline = this.#now() + this.#coldStartTimeoutMs;
      for (;;) {
        try {
          await adapter.startServer(signal);
          break;
        } catch (startError) {
          if (isAbortError(startError)) throw startError;
          if (!isTransientServerStartupError(startError) || this.#now() >= deadline) throw startError;
          const remaining = deadline - this.#now();
          if (remaining <= 0) throw startError;
          await this.#delay(Math.min(this.#coldStartPollIntervalMs, remaining), signal);
        }
      }
      let lastError: unknown = error;
      for (;;) {
        try {
          devices = await adapter.listDevices(signal);
          break;
        } catch (retryError) {
          if (isAbortError(retryError)) throw retryError;
          if (!isTransientServerStartupError(retryError) || this.#now() >= deadline) throw retryError;
          lastError = retryError;
          const remaining = deadline - this.#now();
          if (remaining <= 0) throw lastError;
          await this.#delay(Math.min(this.#coldStartPollIntervalMs, remaining), signal);
        }
      }
    }
    const running = await this.#portProbe(this.#serverPort).catch(() => false);
    if (!existed && running && canOwnAdbServer(this.#pathSource)) {
      this.#ownsServer = true;
      this.#serverOwner = adapter;
    }
    return devices;
  }

  async #targetDevice(requestedSerial: string | undefined, signal?: AbortSignal): Promise<AndroidConnectedDevice> {
    const serial = requestedSerial === undefined ? this.#defaultDeviceSerial : validateConfiguredSerial(requestedSerial);
    const devices = await this.listDevices(signal);
    if (serial !== undefined) {
      const match = devices.find((device) => device.serial === serial);
      if (match === undefined) throw new AndroidRuntimeError("no_device", "Requested Android device is not connected.");
      assertReadyDevice(match);
      return match;
    }
    const ready = devices.filter((device) => device.state === "device");
    if (ready.length === 1) return ready[0] as AndroidConnectedDevice;
    if (ready.length > 1) throw new AndroidRuntimeError("multiple_devices", "Multiple Android devices are connected.");
    const unauthorized = devices.find((device) => device.state === "unauthorized");
    if (unauthorized !== undefined) throw new AndroidRuntimeError("device_unauthorized", "Android device is unauthorized.");
    const offline = devices.find((device) => device.state === "offline");
    if (offline !== undefined) throw new AndroidRuntimeError("device_offline", "Android device is offline.");
    throw new AndroidRuntimeError("no_device", "No Android device is connected.");
  }

  async #screenForAction(
    sessionId: string,
    serial: string,
    signal?: AbortSignal
  ): Promise<AndroidScreenState> {
    const cached = this.#freshSnapshot(sessionId, serial);
    if (cached !== undefined) return cached.snapshot.screen;
    const adapter = await this.#useAdapter(signal);
    const snapshot = await adapter.snapshot(serial, signal);
    this.#snapshots.set(snapshotKey(sessionId, serial), { snapshot, capturedAt: this.#now() });
    return snapshot.screen;
  }

  #freshSnapshot(sessionId: string, serial: string): CachedSnapshot | undefined {
    const key = snapshotKey(sessionId, serial);
    const cached = this.#snapshots.get(key);
    if (cached === undefined) return undefined;
    if (this.#now() - cached.capturedAt > this.#snapshotMaximumAgeMs) {
      this.#snapshots.delete(key);
      return undefined;
    }
    return cached;
  }

  #dropSnapshotsForSerial(serial: string): void {
    for (const [key, cached] of this.#snapshots) {
      if (cached.snapshot.deviceSerial === serial) this.#snapshots.delete(key);
    }
  }

  #enqueueDevice<T>(serial: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#deviceTails.get(serial) ?? Promise.resolve();
    const run = previous.then(operation, operation);
    const tail = run.then(() => undefined, () => undefined);
    this.#deviceTails.set(serial, tail);
    void tail.finally(() => {
      if (this.#deviceTails.get(serial) === tail) this.#deviceTails.delete(serial);
    });
    return run;
  }

  #beginChecking(): void {
    this.#checkingOperations += 1;
    this.#emitActivityState();
  }

  #endChecking(): void {
    this.#checkingOperations = Math.max(0, this.#checkingOperations - 1);
    this.#emitActivityState();
  }

  #setPreparing(preparing: boolean): void {
    this.#preparing = preparing;
    this.#emitActivityState();
  }

  #emitActivityState(): void {
    const state = this.activityState();
    if (state === this.#lastEmittedActivity) return;
    this.#lastEmittedActivity = state;
    try {
      this.#onActivityStateChange?.(state);
    } catch {
      // State observers are informational and cannot alter runtime behavior.
    }
  }

  async #useAdapter(signal?: AbortSignal, allowPreparation = true): Promise<AndroidAdbAdapter> {
    const existing = this.#adapter;
    if (existing !== undefined) return existing;
    const resolver = this.#resolver;
    if (resolver === undefined) throw new AndroidRuntimeError("adb_not_found", "ADB adapter is unavailable.");
    const resolved = await resolver.resolve(signal, { allowPreparation });
    this.#adapter = resolved.adapter;
    this.#executablePath = resolved.executablePath;
    this.#pathSource = resolved.pathSource;
    return resolved.adapter;
  }

  async #serverState(): Promise<"running" | "stopped" | "unknown"> {
    try {
      return await this.#portProbe(this.#serverPort) ? "running" : "stopped";
    } catch {
      return "unknown";
    }
  }

  #unsupportedStatus(): AndroidRuntimeStatus {
    return {
      supported: false,
      platform: this.#platform,
      architecture: this.#architecture,
      installation: {
        state: "unsupported",
        pathSource: this.#pathSource
      },
      server: {
        state: "unknown",
        port: this.#serverPort,
        managedByRuntime: false
      },
      devices: [],
      ...(this.#defaultDeviceSerial === undefined ? {} : {
        configuredDefaultDeviceSerial: this.#defaultDeviceSerial
      }),
      issue: "unsupported_platform",
      activityState: this.activityState()
    };
  }

  #assertSupported(): void {
    this.#assertUsable();
    if (this.#platform === "unsupported") {
      throw new AndroidRuntimeError("unsupported_platform", "Android automation is unavailable on this platform.");
    }
  }

  #assertUsable(): void {
    if (this.#disposed) throw new AndroidRuntimeError("command_failed", "Android runtime is closed.");
  }
}

function canOwnAdbServer(source: AndroidAdbPathSource): boolean {
  return source === "bundled" || source === "prepared";
}

export function normalizeAndroidPlatform(platform: NodeJS.Platform): AndroidHostPlatform {
  return platform === "darwin" || platform === "linux" || platform === "win32"
    ? platform
    : "unsupported";
}

export function resolveAndroidAdbExecutable(input: {
  readonly platform: NodeJS.Platform;
  readonly environment: NodeJS.ProcessEnv;
  readonly homeDirectory: string;
  readonly explicitPath?: string;
  readonly explicitSource?: AndroidAdbPathSource;
  readonly bundledPaths?: readonly string[];
  readonly preparedPath?: string;
  readonly pathExists: (path: string) => boolean;
}): { readonly executablePath: string; readonly pathSource: AndroidAdbPathSource } {
  const candidate = buildAndroidAdbCandidates({
    platform: input.platform,
    environment: input.environment,
    homeDirectory: input.homeDirectory,
    customPath: input.explicitPath,
    bundledPaths: input.bundledPaths,
    preparedPath: input.preparedPath,
    pathExists: input.pathExists
  })[0];
  if (candidate === undefined) {
    return { executablePath: input.platform === "win32" ? "adb.exe" : "adb", pathSource: "path" };
  }
  return {
    executablePath: candidate.executablePath,
    pathSource: input.explicitPath === undefined
      ? candidate.pathSource
      : input.explicitSource ?? candidate.pathSource
  };
}

function classifyDevices(
  devices: readonly AndroidConnectedDevice[],
  configuredSerial: string | undefined
): { readonly serial?: string; readonly issue?: AndroidRuntimeIssue } {
  if (configuredSerial !== undefined) {
    const match = devices.find((device) => device.serial === configuredSerial);
    if (match === undefined) return { issue: "no_device" };
    if (match.state === "device") return { serial: match.serial };
    if (match.state === "unauthorized") return { issue: "device_unauthorized" };
    if (match.state === "offline") return { issue: "device_offline" };
    return { issue: "no_device" };
  }
  const ready = devices.filter((device) => device.state === "device");
  if (ready.length === 1) return { serial: ready[0]?.serial };
  if (ready.length > 1) return { issue: "multiple_devices" };
  if (devices.some((device) => device.state === "unauthorized")) return { issue: "device_unauthorized" };
  if (devices.some((device) => device.state === "offline")) return { issue: "device_offline" };
  return { issue: "no_device" };
}

function assertReadyDevice(device: AndroidConnectedDevice): void {
  if (device.state === "device") return;
  if (device.state === "unauthorized") {
    throw new AndroidRuntimeError("device_unauthorized", "Requested Android device is unauthorized.");
  }
  if (device.state === "offline") {
    throw new AndroidRuntimeError("device_offline", "Requested Android device is offline.");
  }
  throw new AndroidRuntimeError("no_device", "Requested Android device is not ready.");
}

function assertPointInScreen(point: AndroidPoint, screen: AndroidScreenState): void {
  if (
    !Number.isSafeInteger(point.x)
    || !Number.isSafeInteger(point.y)
    || point.x < 0
    || point.y < 0
    || point.x >= screen.width
    || point.y >= screen.height
  ) {
    throw new AndroidRuntimeError(
      "invalid_coordinate",
      `Coordinate is outside the ${screen.width}x${screen.height} Android screen.`
    );
  }
}

function snapshotKey(sessionId: string, serial: string): string {
  return `${sessionId}\0${serial}`;
}

function validateSessionId(value: string): string {
  const sessionId = value.trim();
  if (sessionId === "" || sessionId.length > 1_024 || sessionId.includes("\0")) {
    throw new AndroidRuntimeError("invalid_session", "Android automation session ID is invalid.");
  }
  return sessionId;
}

function validateConfiguredSerial(value: string): string {
  const serial = value.trim();
  if (
    serial === ""
    || serial.length > 255
    || serial.startsWith("-")
    || !/^[A-Za-z0-9[\]._:%-]+$/u.test(serial)
  ) throw new AndroidRuntimeError("invalid_device_serial", "Configured Android device serial is invalid.");
  return serial;
}

function boundedExecutable(value: string): string {
  if (value === "" || value.length > 32_768 || value.includes("\0")) {
    throw new TypeError("ADB executable path is invalid.");
  }
  return value;
}

function boundedServerPort(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) {
    throw new RangeError("ADB server port must be between one and 65535.");
  }
  return value;
}

function environmentServerPort(value: string | undefined): number {
  const parsed = value === undefined || value.trim() === "" ? Number.NaN : Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 65_535
    ? parsed
    : DEFAULT_ADB_SERVER_PORT;
}

function boundedSnapshotAge(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 60 * 60_000) {
    throw new RangeError("Android snapshot lifetime must be between one millisecond and one hour.");
  }
  return value;
}

function boundedColdStartTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 60_000) {
    throw new RangeError("ADB cold-start timeout must be between one millisecond and one minute.");
  }
  return value;
}

function boundedPollInterval(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 5_000) {
    throw new RangeError("ADB cold-start poll interval must be between one millisecond and five seconds.");
  }
  return value;
}

function redactExecutablePath(executablePath: string, roots: readonly string[]): string {
  const redacted = redactAndroidOutput(executablePath, roots);
  return redacted === executablePath && (executablePath.includes("/") || executablePath.includes("\\"))
    ? basename(executablePath)
    : redacted;
}

function redactPreparation(
  preparation: ReturnType<AndroidAdbResolver["preparationState"]>,
  roots: readonly string[]
): ReturnType<AndroidAdbResolver["preparationState"]> {
  return {
    ...preparation,
    ...(preparation.executablePath === undefined ? {} : {
      executablePath: redactExecutablePath(preparation.executablePath, roots)
    }),
    ...(preparation.error === undefined ? {} : {
      error: redactAndroidOutput(preparation.error, roots)
    })
  };
}

function isTransientServerStartupError(value: unknown): boolean {
  if (isAbortError(value)) return false;
  if (!(value instanceof Error)) return false;
  return /(?:timed out|protocol fault|connection reset|cannot connect to daemon|daemon not running|failed to connect.*daemon)/iu
    .test(value.message);
}

function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) return Promise.reject(abortError());
  return new Promise<void>((resolveDelay, reject) => {
    const finish = (): void => {
      signal?.removeEventListener("abort", onAbort);
      resolveDelay();
    };
    const timer = setTimeout(finish, milliseconds);
    const onAbort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted === true) onAbort();
  });
}

function safeError(value: unknown, roots: readonly string[]): string {
  return redactAndroidOutput(value instanceof Error ? value.message : String(value), roots).slice(0, 2_048);
}

function isLocalPortListening(port: number): Promise<boolean> {
  return new Promise((resolveListening) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const finish = (listening: boolean): void => {
      socket.removeAllListeners();
      socket.destroy();
      resolveListening(listening);
    };
    socket.setTimeout(250);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

function withSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return promise;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolvePromise, reject) => {
    const onAbort = (): void => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolvePromise, reject).finally(() => signal.removeEventListener("abort", onAbort)).catch(() => undefined);
  });
}

function abortError(): Error {
  return new DOMException("The Android automation request was cancelled.", "AbortError");
}

function isAbortError(value: unknown): boolean {
  return value instanceof Error && value.name === "AbortError";
}
