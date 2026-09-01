import { existsSync } from "node:fs";
import { homedir, machine } from "node:os";
import { join } from "node:path";

import { createSocks5Dispatcher } from "@joko/outbound-network";
import { ProxyAgent, fetch as proxyFetch, type Dispatcher } from "undici";

import {
  BoundedCommandRunner,
  ComputerProcessError,
  normalizeComputerPlatform,
  type ComputerCommandRequest,
  type ComputerCommandResult,
  type ComputerCommandRunner,
  type ComputerHostPlatform,
  type ComputerProcessActivitySample
} from "./process-runner.js";
import {
  clearStaleComputerInstallLock,
  ComputerInstallActivitySampler,
  type ComputerInstallAsset
} from "./install-activity.js";
import { ComputerProcessSnapshotReader } from "./process-snapshot.js";
import { callWindowsComputerFallback, type ComputerWindowsFallbackTool } from "./windows-fallback.js";

const UPSTREAM_COMMAND = "cua-driver";
const PASSIVE_PERMISSION_MINIMUM_VERSION = "0.12.2";
const POSIX_INSTALL_URL = "https://raw.githubusercontent.com/trycua/cua/main/libs/cua-driver/scripts/install.sh";
const WINDOWS_INSTALL_URL = "https://raw.githubusercontent.com/trycua/cua/main/libs/cua-driver/scripts/install.ps1";
const DRIVER_TAG_PREFIX = "cua-driver-rs-v";
const DRIVER_TAGS_URL = `https://api.github.com/repos/trycua/cua/git/matching-refs/tags/${DRIVER_TAG_PREFIX}`;
const DRIVER_RELEASE_URL = "https://api.github.com/repos/trycua/cua/releases/tags";
const UPDATE_CHECK_TIMEOUT_MS = 10_000;
const UPDATE_REFRESH_INTERVAL_MS = 10 * 60_000;
const CLI_FALLBACK_TIMEOUT_MS = 8_000;
const INSTALL_IDLE_TIMEOUT_MS = 3 * 60_000;
const INSTALL_HARD_TIMEOUT_MS = 30 * 60_000;
const WINDOWS_INSTALL_IDLE_TIMEOUT_MS = INSTALL_HARD_TIMEOUT_MS;
const PERMISSION_GRANT_SETTLE_MS = 750;
const PERMISSION_GRANT_REUSE_MS = 15_000;
const MAC_PERMISSION_SETTINGS = Object.freeze({
  accessibility: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
  screenRecording: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
});

export type ComputerDaemonState = "running" | "stopped" | "unknown";
export type ComputerPermissionGrant = "granted" | "missing" | "unknown" | "not_required";
export type ComputerSystemPermission = keyof typeof MAC_PERMISSION_SETTINGS;

export interface ComputerPlatformSummary {
  readonly platform: ComputerHostPlatform;
  readonly architecture: string;
  readonly supported: boolean;
  readonly permissionsRequired: boolean;
  readonly installation: "powershell" | "posix" | "unsupported";
}

export interface ComputerDaemonSummary {
  readonly state: ComputerDaemonState;
  readonly processId?: number;
}

export interface ComputerPermissionSummary {
  readonly required: boolean;
  readonly status: ComputerPermissionGrant;
  readonly accessibility: ComputerPermissionGrant;
  readonly screenRecording: ComputerPermissionGrant;
  readonly liveScreenCapture: ComputerPermissionGrant;
  readonly canGrant: boolean;
  readonly passiveProbe: "not_required" | "supported" | "unsupported_version" | "daemon_unavailable" | "failed";
}

export interface ComputerRuntimeStatus {
  readonly installed: boolean;
  readonly executablePath?: string;
  readonly version?: string;
  readonly platform: ComputerPlatformSummary;
  readonly daemon: ComputerDaemonSummary;
  readonly permissions: ComputerPermissionSummary;
  readonly issue?: "not_found" | "version_failed";
}

export interface ComputerExplicitActionOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly onSpawn?: (pid: number | undefined) => void;
}

export interface ComputerInstallOptions extends ComputerExplicitActionOptions {
  readonly targetVersion?: string;
  readonly assets?: readonly ComputerInstallAsset[];
  readonly onProgress?: (progress: ComputerRuntimeUpdateProgress) => void;
}

export interface ComputerRuntimeUpdateProgress {
  readonly phase: "downloading" | "installing" | "done";
  readonly downloadedBytes: number | null;
  readonly totalBytes: number | null;
}

export interface ComputerRuntimeUpdateCheck {
  readonly currentVersion?: string;
  readonly latestVersion?: string;
  readonly updateAvailable: boolean;
  readonly updating: boolean;
}

export type ComputerCliFallbackTool = "get_screen_size" | "get_cursor_position";

export interface ComputerUpdateOptions {
  readonly signal?: AbortSignal;
  readonly fetchImpl?: typeof fetch;
  readonly joinOnly?: boolean;
  readonly onProgress?: (progress: ComputerRuntimeUpdateProgress) => void;
}

export interface ComputerExplicitActionResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly status: ComputerRuntimeStatus;
}

interface ComputerExplicitRunOptions extends ComputerExplicitActionOptions {
  readonly idleTimeoutMs?: number;
  readonly activityPollMs?: number;
  readonly sampleProcessActivity?: (
    processId: number,
    signal: AbortSignal
  ) => Promise<ComputerProcessActivitySample | undefined>;
  readonly onProcessActivity?: (sample: ComputerProcessActivitySample) => void;
  readonly killProcessTree?: boolean;
}

export interface ComputerCommandPlan {
  readonly command: string;
  readonly arguments: readonly string[];
  readonly extraEnvironment?: Readonly<Record<string, string>>;
}

export interface ComputerCommandPlanContext {
  readonly platform: ComputerHostPlatform;
  readonly executablePath: string;
  readonly targetVersion?: string;
}

export type ComputerCommandPlanFactory = (context: ComputerCommandPlanContext) => ComputerCommandPlan;

export interface ComputerRuntimeOptions {
  readonly platform?: NodeJS.Platform;
  readonly architecture?: string;
  readonly executablePath?: string;
  readonly homeDirectory?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly runner?: ComputerCommandRunner;
  readonly pathExists?: (path: string) => boolean;
  readonly installPlan?: ComputerCommandPlanFactory;
  readonly permissionGrantPlan?: ComputerCommandPlanFactory;
  readonly statusTimeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
  readonly resolveOutboundProxy?: ComputerOutboundProxyResolver;
  readonly now?: () => number;
  readonly permissionGrantSettleMs?: number;
  readonly permissionGrantReuseMs?: number;
}

export type ComputerOutboundProxyResolver = (
  upstreamUrl: string,
  options?: { readonly signal?: AbortSignal }
) => Promise<string | null | undefined> | string | null | undefined;

export class ComputerRuntimeActionError extends Error {
  constructor(
    readonly code:
      | "unsupported_platform"
      | "not_installed"
      | "install_failed"
      | "permission_grant_failed"
      | "permission_settings_failed"
      | "no_verified_update"
      | "update_failed",
    readonly result?: ComputerCommandResult
  ) {
    super(actionErrorMessage(code));
    this.name = "ComputerRuntimeActionError";
  }
}

export class ComputerRuntime {
  readonly #platformSource: NodeJS.Platform;
  readonly #platform: ComputerHostPlatform;
  readonly #architecture: string;
  readonly #explicitExecutablePath: string | undefined;
  readonly #homeDirectory: string;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #runner: ComputerCommandRunner;
  readonly #pathExists: (path: string) => boolean;
  readonly #installPlan: ComputerCommandPlanFactory;
  readonly #permissionGrantPlan: ComputerCommandPlanFactory;
  readonly #statusTimeoutMs: number;
  readonly #fetchImpl: typeof fetch;
  readonly #proxyDispatchers: ReadonlySet<Dispatcher>;
  readonly #resolveOutboundProxy: ComputerOutboundProxyResolver | undefined;
  readonly #now: () => number;
  readonly #permissionGrantSettleMs: number;
  readonly #permissionGrantReuseMs: number;
  readonly #processSnapshots: ComputerProcessSnapshotReader;
  #cachedUpdate: Omit<ComputerRuntimeUpdateCheck, "updating"> | undefined;
  #cachedInstallableRelease: InstallableDriverRelease | undefined;
  #updateCheckedAt = 0;
  #updateCheckInFlight: Promise<Omit<ComputerRuntimeUpdateCheck, "updating">> | undefined;
  #updateInFlight: Promise<ComputerExplicitActionResult> | undefined;
  #activeDriverSessions = 0;
  #permissionCache: {
    readonly processId: number;
    readonly summary: ComputerPermissionSummary;
  } | undefined;
  #permissionGrant: {
    readonly promise: Promise<ComputerCommandResult>;
    readonly abort: AbortController;
    readonly startedAt: number;
  } | undefined;
  #lastPermissionGrantResult: ComputerCommandResult | undefined;

  constructor(options: ComputerRuntimeOptions = {}) {
    this.#platformSource = options.platform ?? process.platform;
    this.#platform = normalizeComputerPlatform(this.#platformSource);
    this.#architecture = options.architecture ?? resolvedHostArchitecture(this.#platformSource, options.environment ?? process.env);
    this.#explicitExecutablePath = boundedOptionalPath(options.executablePath);
    this.#homeDirectory = options.homeDirectory ?? homedir();
    this.#environment = options.environment ?? process.env;
    this.#runner = options.runner ?? new BoundedCommandRunner({
      platform: this.#platformSource,
      environment: this.#environment
    });
    this.#pathExists = options.pathExists ?? existsSync;
    this.#installPlan = options.installPlan ?? defaultInstallPlan;
    this.#permissionGrantPlan = options.permissionGrantPlan ?? ((context) => ({
      command: context.executablePath,
      arguments: ["permissions", "grant"]
    }));
    this.#statusTimeoutMs = boundedTimeout(options.statusTimeoutMs ?? 5_000, "Status timeout");
    this.#resolveOutboundProxy = options.resolveOutboundProxy;
    const outbound = options.fetchImpl === undefined
      ? computerUpdateFetch(this.#environment, this.#resolveOutboundProxy)
      : { fetchImpl: options.fetchImpl, dispatchers: new Set<Dispatcher>() };
    this.#fetchImpl = outbound.fetchImpl;
    this.#proxyDispatchers = outbound.dispatchers;
    this.#now = options.now ?? Date.now;
    this.#permissionGrantSettleMs = boundedDuration(
      options.permissionGrantSettleMs ?? PERMISSION_GRANT_SETTLE_MS,
      0,
      10_000,
      "Permission grant settle window"
    );
    this.#permissionGrantReuseMs = boundedDuration(
      options.permissionGrantReuseMs ?? PERMISSION_GRANT_REUSE_MS,
      1,
      60_000,
      "Permission grant reuse window"
    );
    this.#processSnapshots = new ComputerProcessSnapshotReader({
      platform: this.#platform,
      runner: this.#runner,
      pathExists: this.#pathExists,
      now: this.#now
    });
  }

  platformSummary(): ComputerPlatformSummary {
    return {
      platform: this.#platform,
      architecture: this.#architecture,
      supported: this.#platform !== "unsupported",
      permissionsRequired: this.#platform === "darwin",
      installation: this.#platform === "win32"
        ? "powershell"
        : this.#platform === "darwin" || this.#platform === "linux" ? "posix" : "unsupported"
    };
  }

  executablePath(): string {
    if (this.#explicitExecutablePath !== undefined) return this.#explicitExecutablePath;
    for (const candidate of this.#executableCandidates()) {
      if (candidate === UPSTREAM_COMMAND || this.#pathExists(candidate)) return candidate;
    }
    return UPSTREAM_COMMAND;
  }

  retainDriverSession(): void {
    this.#activeDriverSessions += 1;
  }

  releaseDriverSession(): void {
    this.#activeDriverSessions = Math.max(0, this.#activeDriverSessions - 1);
  }

  async status(options: {
    readonly signal?: AbortSignal;
    readonly fresh?: boolean;
    readonly bypassPermissionCache?: boolean;
    readonly ensureDaemon?: boolean;
  } = {}): Promise<ComputerRuntimeStatus> {
    const permissionGrantAtStart = this.#permissionGrant?.promise;
    const platform = this.platformSummary();
    const executablePath = this.executablePath();
    let versionResult: ComputerCommandResult;
    try {
      versionResult = await this.#runner.run({
        command: executablePath,
        arguments: ["--version"],
        timeoutMs: this.#statusTimeoutMs,
        signal: options.signal,
        maximumStdoutBytes: 4 * 1024,
        maximumStderrBytes: 4 * 1024
      });
    } catch (error) {
      if (isAbortError(error)) throw error;
      return unavailableStatus(platform, error instanceof ComputerProcessError && error.kind === "spawn" ? "not_found" : "version_failed");
    }
    if (versionResult.exitCode !== 0) return unavailableStatus(platform, "version_failed");

    const version = normalizedVersion(versionResult.stdout);
    let daemon = await this.#daemonStatus(executablePath, options.signal);
    if (
      options.fresh === true
      && this.#platform === "darwin"
      && daemon.state === "running"
      && this.#activeDriverSessions === 0
      && this.#pathExists("/Applications/CuaDriver.app")
    ) {
      try {
        await this.#runner.run({
          command: executablePath,
          arguments: ["stop"],
          timeoutMs: this.#statusTimeoutMs,
          signal: options.signal,
          maximumStdoutBytes: 4 * 1024,
          maximumStderrBytes: 4 * 1024
        });
        daemon = await this.#daemonStatus(executablePath, options.signal);
      } catch (error) {
        if (isAbortError(error)) throw error;
      }
    }
    if (
      (options.fresh === true || options.ensureDaemon === true)
      && this.#platform === "darwin"
      && daemon.state === "stopped"
    ) {
      daemon = await this.#tryStartMacDaemon(executablePath, options.signal);
    }
    const permissions = await this.#permissionStatus(
      executablePath,
      version,
      daemon,
      options.signal,
      options.fresh === true || options.bypassPermissionCache === true
    );
    if (permissions.status === "granted" && permissionGrantAtStart !== undefined) {
      this.#stopPermissionGrant(permissionGrantAtStart);
    }
    return {
      installed: true,
      executablePath,
      ...(version === undefined ? {} : { version }),
      platform,
      daemon,
      permissions
    };
  }

  async install(options: ComputerInstallOptions = {}): Promise<ComputerExplicitActionResult> {
    if (this.#platform === "unsupported") throw new ComputerRuntimeActionError("unsupported_platform");
    const requestedVersion = options.targetVersion === undefined ? undefined : validateStableVersion(options.targetVersion);
    const rawPlan = validatePlan(this.#installPlan({
      platform: this.#platform,
      executablePath: this.executablePath(),
      ...(requestedVersion === undefined ? {} : { targetVersion: requestedVersion })
    }));
    const systemProxyEnvironment = hasProxyEnvironment(this.#environment)
      ? undefined
      : installerProxyEnvironment(await resolveOutboundProxySafely(
          this.#resolveOutboundProxy,
          this.#platform === "win32" ? WINDOWS_INSTALL_URL : POSIX_INSTALL_URL,
          options.signal
        ));
    const plan = {
      ...rawPlan,
      extraEnvironment: {
        ...installerEnvironment(this.#environment),
        ...systemProxyEnvironment,
        CUA_DRIVER_NO_MODIFY_PATH: "1",
        CUA_DRIVER_RS_NO_MODIFY_PATH: "1",
        ...rawPlan.extraEnvironment,
        ...(requestedVersion === undefined ? {} : { CUA_DRIVER_RS_VERSION: requestedVersion })
      }
    };
    await clearStaleComputerInstallLock(join(
      this.#homeDirectory,
      ".cua-driver",
      "packages",
      ".install.lock.d"
    ));
    const activity = new ComputerInstallActivitySampler({
      platform: this.#platformSource,
      assets: options.assets,
      searchRoots: [
        this.#environment["TEMP"] ?? this.#environment["TMP"] ?? join(this.#homeDirectory, ".cua-driver", "tmp"),
        join(this.#homeDirectory, ".cua-driver")
      ]
    });
    let result: ComputerCommandResult;
    try {
      result = await this.#runExplicit(plan, {
        ...options,
        timeoutMs: options.timeoutMs ?? INSTALL_HARD_TIMEOUT_MS,
        idleTimeoutMs: this.#platform === "win32" ? WINDOWS_INSTALL_IDLE_TIMEOUT_MS : INSTALL_IDLE_TIMEOUT_MS,
        activityPollMs: this.#platform === "win32" ? 2_000 : 1_000,
        sampleProcessActivity: (processId, signal) => activity.sample(processId, signal),
        onProcessActivity: (sample) => {
          if (sample.phase === undefined) return;
          options.onProgress?.({
            phase: sample.phase,
            downloadedBytes: sample.phase === "downloading" ? sample.downloadedBytes ?? null : null,
            totalBytes: sample.phase === "downloading" ? sample.totalBytes ?? null : null
          });
        },
        killProcessTree: true
      });
    } catch (error) {
      if (isAbortError(error)) throw error;
      if (error instanceof ComputerProcessError) throw new ComputerRuntimeActionError("install_failed", error.result);
      throw error;
    }
    if (result.exitCode !== 0) throw new ComputerRuntimeActionError("install_failed", result);
    options.onProgress?.({ phase: "installing", downloadedBytes: null, totalBytes: null });
    const status = await this.status({ signal: options.signal, bypassPermissionCache: true });
    if (!status.installed) throw new ComputerRuntimeActionError("install_failed", result);
    return actionResult(result, status);
  }

  async grantPermissions(options: ComputerExplicitActionOptions = {}): Promise<ComputerExplicitActionResult> {
    const before = await this.status({ signal: options.signal });
    if (!before.installed || before.executablePath === undefined) {
      throw new ComputerRuntimeActionError("not_installed");
    }
    if (!before.permissions.required) return actionResult(emptyCommandResult(), before);
    const flow = this.#startPermissionGrant(before.executablePath, options.timeoutMs ?? 210_000);
    try {
      await Promise.race([
        flow.promise.catch(() => undefined),
        abortableDelay(this.#permissionGrantSettleMs, options.signal)
      ]);
    } catch (error) {
      if (isAbortError(error)) this.#stopPermissionGrant(flow.promise);
      throw error;
    }
    const status = await this.status({
      signal: options.signal,
      ensureDaemon: true,
      bypassPermissionCache: true
    });
    return actionResult(this.#lastPermissionGrantResult ?? emptyCommandResult(), status);
  }

  cancelPermissionGrant(): void {
    this.#stopPermissionGrant();
  }

  async openPermissionSettings(
    permission: ComputerSystemPermission,
    options: { readonly signal?: AbortSignal } = {}
  ): Promise<void> {
    if (this.#platform !== "darwin") throw new ComputerRuntimeActionError("unsupported_platform");
    const uri = MAC_PERMISSION_SETTINGS[permission];
    if (uri === undefined) throw new TypeError("Computer system permission is invalid.");
    let result: ComputerCommandResult;
    try {
      result = await this.#runner.run({
        command: "/usr/bin/open",
        arguments: [uri],
        timeoutMs: 5_000,
        signal: options.signal,
        maximumStdoutBytes: 4 * 1024,
        maximumStderrBytes: 4 * 1024
      });
    } catch (error) {
      if (isAbortError(error)) throw error;
      throw new ComputerRuntimeActionError(
        "permission_settings_failed",
        error instanceof ComputerProcessError ? error.result : undefined
      );
    }
    if (result.exitCode !== 0) {
      throw new ComputerRuntimeActionError("permission_settings_failed", result);
    }
  }

  async dispose(): Promise<void> {
    this.#stopPermissionGrant();
    await Promise.all([...this.#proxyDispatchers].map(async (dispatcher) => {
      await dispatcher.close().catch(() => undefined);
    }));
  }

  async checkForUpdate(options: {
    readonly signal?: AbortSignal;
    readonly fresh?: boolean;
    readonly fetchImpl?: typeof fetch;
  } = {}): Promise<ComputerRuntimeUpdateCheck> {
    const updating = this.#updateInFlight !== undefined;
    const refreshDue = Date.now() - this.#updateCheckedAt >= UPDATE_REFRESH_INTERVAL_MS;
    if (this.#cachedUpdate !== undefined && options.fresh !== true) {
      if (!updating && refreshDue) void this.#startUpdateCheck(options.fetchImpl ?? this.#fetchImpl, options.signal);
      return { ...this.#cachedUpdate, updating };
    }
    const result = await this.#startUpdateCheck(options.fetchImpl ?? this.#fetchImpl, options.signal);
    return { ...result, updating: this.#updateInFlight !== undefined };
  }

  async update(options: ComputerUpdateOptions = {}): Promise<ComputerExplicitActionResult> {
    if (this.#updateInFlight !== undefined) return this.#updateInFlight;
    if (options.joinOnly === true) {
      const status = await this.status({ signal: options.signal });
      return actionResult(emptyCommandResult(), status);
    }
    const task = (async (): Promise<ComputerExplicitActionResult> => {
      const verified = await this.#revalidateUpdateTarget(
        options.fetchImpl ?? this.#fetchImpl,
        options.signal
      );
      if (verified === undefined) {
        throw new ComputerRuntimeActionError("no_verified_update");
      }
      options.onProgress?.({
        phase: "downloading",
        downloadedBytes: null,
        totalBytes: verified.assetSize
      });
      const installed = await this.install({
        signal: options.signal,
        targetVersion: verified.version,
        assets: [{ name: verified.assetName, size: verified.assetSize }],
        onProgress: options.onProgress,
        onSpawn: () => undefined
      });
      const installedVersion = installed.status.version;
      if (installedVersion === undefined || compareSemver(installedVersion, verified.version) < 0) {
        this.#cachedUpdate = undefined;
        this.#cachedInstallableRelease = undefined;
        this.#updateCheckedAt = 0;
        throw new ComputerRuntimeActionError("update_failed");
      }
      this.#cachedUpdate = undefined;
      this.#cachedInstallableRelease = undefined;
      this.#updateCheckedAt = 0;
      return installed;
    })().finally(() => {
      options.onProgress?.({ phase: "done", downloadedBytes: null, totalBytes: null });
      if (this.#updateInFlight === task) this.#updateInFlight = undefined;
    });
    this.#updateInFlight = task;
    return task;
  }

  async callWindowsFallback(
    name: ComputerWindowsFallbackTool,
    arguments_: Readonly<Record<string, unknown>>,
    options: { readonly signal?: AbortSignal } = {}
  ): Promise<Readonly<Record<string, unknown>> | undefined> {
    if (this.#platform !== "win32") return undefined;
    return callWindowsComputerFallback(this.#runner, name, arguments_, options.signal);
  }

  async callCliFallback(
    name: ComputerCliFallbackTool,
    options: { readonly signal?: AbortSignal } = {}
  ): Promise<Readonly<Record<string, unknown>> | undefined> {
    const result = await this.#runner.run({
      command: this.executablePath(),
      arguments: ["call", name],
      stdin: "{}\n",
      timeoutMs: CLI_FALLBACK_TIMEOUT_MS,
      signal: options.signal,
      maximumStdoutBytes: 256 * 1024,
      maximumStderrBytes: 32 * 1024
    });
    if (result.exitCode !== 0 || result.stdoutTruncated) return undefined;
    try {
      const value: unknown = JSON.parse(result.stdout.trim());
      return isRecord(value) ? value : undefined;
    } catch {
      return undefined;
    }
  }

  enrichWindows(
    payload: Readonly<Record<string, unknown>>,
    arguments_: Readonly<Record<string, unknown>>,
    options: { readonly signal?: AbortSignal } = {}
  ): Promise<Readonly<Record<string, unknown>>> {
    return this.#processSnapshots.enrichAndFilter(payload, arguments_, options.signal);
  }

  #startUpdateCheck(
    fetchImpl: typeof fetch,
    signal: AbortSignal | undefined
  ): Promise<Omit<ComputerRuntimeUpdateCheck, "updating">> {
    if (this.#updateCheckInFlight !== undefined) return this.#updateCheckInFlight;
    const knownTarget = this.#cachedUpdate?.updateAvailable === true
      ? this.#cachedUpdate.latestVersion
      : undefined;
    const check = this.#readUpdate(fetchImpl, signal, knownTarget, new Set()).then((result) => {
      if (result.latestVersion !== undefined || result.currentVersion === undefined || this.#cachedUpdate === undefined) {
        this.#cachedUpdate = result;
      }
      return this.#cachedUpdate ?? result;
    }).finally(() => {
      this.#updateCheckedAt = Date.now();
      if (this.#updateCheckInFlight === check) this.#updateCheckInFlight = undefined;
    });
    this.#updateCheckInFlight = check;
    return check;
  }

  async #readUpdate(
    fetchImpl: typeof fetch,
    signal: AbortSignal | undefined,
    knownTarget: string | undefined,
    excludedVersions: ReadonlySet<string>
  ): Promise<Omit<ComputerRuntimeUpdateCheck, "updating">> {
    const currentVersion = await this.#readVersion(signal);
    if (currentVersion === undefined) {
      this.#cachedInstallableRelease = undefined;
      return { updateAvailable: false };
    }
    try {
      const headers = githubHeaders(this.#environment);
      const versions = await fetchDriverVersions(fetchImpl, signal, headers);
      const latestTagVersion = versions[0];
      let knownTargetTransientFailure = false;
      let transientReleaseFailure = false;
      for (const version of versions) {
        if (compareSemver(currentVersion, version) >= 0 || excludedVersions.has(version)) continue;
        let release: InstallableDriverRelease | undefined;
        try {
          release = await fetchInstallableRelease(
            version,
            this.#platformSource,
            this.#architecture,
            fetchImpl,
            signal,
            headers
          );
        } catch (error) {
          if (error instanceof DriverReleaseHttpError && error.status >= 500) {
            transientReleaseFailure = true;
            if (version === knownTarget) knownTargetTransientFailure = true;
            continue;
          }
          throw error;
        }
        if (release !== undefined) {
          if (
            knownTargetTransientFailure
            && knownTarget !== undefined
            && compareSemver(release.version, knownTarget) < 0
          ) return { currentVersion, updateAvailable: false };
          this.#cachedInstallableRelease = release;
          return { currentVersion, latestVersion: release.version, updateAvailable: true };
        }
      }
      if (transientReleaseFailure) return { currentVersion, updateAvailable: false };
      this.#cachedInstallableRelease = undefined;
      return {
        currentVersion,
        latestVersion: latestTagVersion ?? currentVersion,
        updateAvailable: false
      };
    } catch (error) {
      if (isAbortError(error)) throw error;
      return { currentVersion, updateAvailable: false };
    }
  }

  async #revalidateUpdateTarget(
    fetchImpl: typeof fetch,
    signal: AbortSignal | undefined
  ): Promise<InstallableDriverRelease | undefined> {
    const cachedTarget = this.#cachedUpdate?.updateAvailable === true
      ? this.#cachedUpdate.latestVersion
      : undefined;
    if (cachedTarget === undefined) return undefined;
    try {
      const release = await fetchInstallableRelease(
        cachedTarget,
        this.#platformSource,
        this.#architecture,
        fetchImpl,
        signal,
        githubHeaders(this.#environment)
      );
      if (release !== undefined) {
        this.#cachedInstallableRelease = release;
        return release;
      }
      const refreshed = await this.#readUpdate(fetchImpl, signal, undefined, new Set([cachedTarget]));
      this.#cachedUpdate = refreshed;
      if (!refreshed.updateAvailable) this.#cachedInstallableRelease = undefined;
      return refreshed.updateAvailable ? this.#cachedInstallableRelease : undefined;
    } finally {
      this.#updateCheckedAt = this.#now();
    }
  }

  async #readVersion(signal: AbortSignal | undefined): Promise<string | undefined> {
    try {
      const result = await this.#runner.run({
        command: this.executablePath(),
        arguments: ["--version"],
        timeoutMs: this.#statusTimeoutMs,
        signal,
        maximumStdoutBytes: 4 * 1024,
        maximumStderrBytes: 4 * 1024
      });
      return result.exitCode === 0 ? normalizedVersion(result.stdout) : undefined;
    } catch (error) {
      if (isAbortError(error)) throw error;
      return undefined;
    }
  }

  #startPermissionGrant(executablePath: string, timeoutMs: number): {
    readonly promise: Promise<ComputerCommandResult>;
  } {
    const existing = this.#permissionGrant;
    if (existing !== undefined && this.#now() - existing.startedAt < this.#permissionGrantReuseMs) {
      return existing;
    }
    if (existing !== undefined) this.#stopPermissionGrant(existing.promise);
    this.#lastPermissionGrantResult = undefined;
    const plan = validatePlan(this.#permissionGrantPlan({
      platform: this.#platform,
      executablePath
    }));
    const abort = new AbortController();
    const promise = this.#runExplicit(plan, {
      signal: abort.signal,
      timeoutMs,
      killProcessTree: true
    });
    const flow = { promise, abort, startedAt: this.#now() };
    this.#permissionGrant = flow;
    void promise.then(
      (result) => {
        if (this.#permissionGrant === flow) this.#lastPermissionGrantResult = result;
      },
      () => undefined
    ).finally(() => {
      if (this.#permissionGrant === flow) this.#permissionGrant = undefined;
    });
    return flow;
  }

  #stopPermissionGrant(expected?: Promise<ComputerCommandResult>): void {
    const flow = this.#permissionGrant;
    if (flow === undefined || (expected !== undefined && flow.promise !== expected)) return;
    this.#permissionGrant = undefined;
    flow.abort.abort();
  }

  async #runExplicit(plan: ComputerCommandPlan, options: ComputerExplicitRunOptions): Promise<ComputerCommandResult> {
    const request: ComputerCommandRequest = {
      command: plan.command,
      arguments: plan.arguments,
      timeoutMs: boundedTimeout(options.timeoutMs ?? 60_000, "Explicit action timeout"),
      signal: options.signal,
      onSpawn: options.onSpawn,
      maximumStdoutBytes: 1024 * 1024,
      maximumStderrBytes: 256 * 1024,
      ...(options.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: options.idleTimeoutMs }),
      ...(options.activityPollMs === undefined ? {} : { activityPollMs: options.activityPollMs }),
      ...(options.sampleProcessActivity === undefined ? {} : { sampleProcessActivity: options.sampleProcessActivity }),
      ...(options.onProcessActivity === undefined ? {} : { onProcessActivity: options.onProcessActivity }),
      ...(options.killProcessTree === undefined ? {} : { killProcessTree: options.killProcessTree }),
      ...(plan.extraEnvironment === undefined ? {} : { extraEnvironment: plan.extraEnvironment })
    };
    return this.#runner.run(request);
  }

  async #daemonStatus(executablePath: string, signal: AbortSignal | undefined): Promise<ComputerDaemonSummary> {
    try {
      const result = await this.#runner.run({
        command: executablePath,
        arguments: ["status"],
        timeoutMs: this.#statusTimeoutMs,
        signal,
        maximumStdoutBytes: 16 * 1024,
        maximumStderrBytes: 8 * 1024
      });
      if (result.exitCode !== 0) return { state: "stopped" };
      const processId = daemonProcessId(`${result.stdout}\n${result.stderr}`);
      return { state: "running", ...(processId === undefined ? {} : { processId }) };
    } catch (error) {
      if (isAbortError(error)) throw error;
      return { state: "unknown" };
    }
  }

  async #tryStartMacDaemon(
    executablePath: string,
    signal: AbortSignal | undefined
  ): Promise<ComputerDaemonSummary> {
    try {
      const started = await this.#runner.run({
        command: "open",
        arguments: ["-n", "-g", "-a", "CuaDriver", "--args", "serve", "--no-permissions-gate"],
        timeoutMs: 5_000,
        signal,
        maximumStdoutBytes: 4 * 1024,
        maximumStderrBytes: 4 * 1024
      });
      if (started.exitCode !== 0) return { state: "stopped" };
      for (let attempt = 0; attempt < 10; attempt += 1) {
        await abortableDelay(300, signal);
        const daemon = await this.#daemonStatus(executablePath, signal);
        if (daemon.state === "running") return daemon;
      }
    } catch (error) {
      if (isAbortError(error)) throw error;
    }
    return { state: "stopped" };
  }

  async #permissionStatus(
    executablePath: string,
    version: string | undefined,
    daemon: ComputerDaemonSummary,
    signal: AbortSignal | undefined,
    bypassCache: boolean
  ): Promise<ComputerPermissionSummary> {
    if (this.#platform !== "darwin") return nonMacPermissionSummary(this.#platform);
    if (version === undefined || compareSemver(version, PASSIVE_PERMISSION_MINIMUM_VERSION) < 0) {
      return unknownMacPermissionSummary("unsupported_version");
    }
    if (daemon.state !== "running") return unknownMacPermissionSummary("daemon_unavailable");
    if (
      !bypassCache
      && daemon.processId !== undefined
      && this.#permissionCache?.processId === daemon.processId
      && this.#permissionCache.summary.liveScreenCapture === "missing"
    ) return this.#permissionCache.summary;
    try {
      const result = await this.#runner.run({
        command: executablePath,
        arguments: ["permissions", "status", "--json"],
        timeoutMs: this.#statusTimeoutMs,
        signal,
        maximumStdoutBytes: 32 * 1024,
        maximumStderrBytes: 8 * 1024
      });
      if (result.exitCode !== 0) return unknownMacPermissionSummary("failed");
      const summary = parseMacPermissionSummary(result.stdout);
      if (daemon.processId !== undefined && summary.status !== "unknown") {
        this.#permissionCache = { processId: daemon.processId, summary };
      } else {
        this.#permissionCache = undefined;
      }
      return summary;
    } catch (error) {
      if (isAbortError(error)) throw error;
      return unknownMacPermissionSummary("failed");
    }
  }

  #executableCandidates(): readonly string[] {
    const candidates: string[] = [];
    if (this.#platform === "win32") {
      const localAppData = this.#environment["LOCALAPPDATA"];
      if (typeof localAppData === "string" && localAppData.length > 0) {
        candidates.push(join(localAppData, "Programs", "Cua", UPSTREAM_COMMAND, "bin", `${UPSTREAM_COMMAND}.exe`));
      }
    } else {
      candidates.push(
        join(this.#homeDirectory, ".local", "bin", UPSTREAM_COMMAND),
        `/opt/homebrew/bin/${UPSTREAM_COMMAND}`,
        `/usr/local/bin/${UPSTREAM_COMMAND}`
      );
    }
    candidates.push(UPSTREAM_COMMAND);
    return [...new Set(candidates)];
  }
}

export function compareSemver(left: string, right: string): number {
  const leftParts = semverCore(left);
  const rightParts = semverCore(right);
  if (leftParts === undefined || rightParts === undefined) return 0;
  for (let index = 0; index < 3; index += 1) {
    const difference = leftParts[index]! - rightParts[index]!;
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
  return 0;
}

function defaultInstallPlan(context: ComputerCommandPlanContext): ComputerCommandPlan {
  const extraEnvironment = context.targetVersion === undefined
    ? undefined
    : { CUA_DRIVER_RS_VERSION: validateStableVersion(context.targetVersion) };
  if (context.platform === "win32") {
    return {
      command: "powershell.exe",
      arguments: [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        `$ProgressPreference='SilentlyContinue'; Invoke-RestMethod -Uri '${WINDOWS_INSTALL_URL}' | Invoke-Expression`
      ],
      ...(extraEnvironment === undefined ? {} : { extraEnvironment })
    };
  }
  if (context.platform === "darwin" || context.platform === "linux") {
    return {
      command: "/bin/bash",
      arguments: ["-c", `set -euo pipefail; curl -fsSL '${POSIX_INSTALL_URL}' | /bin/bash`],
      ...(extraEnvironment === undefined ? {} : { extraEnvironment })
    };
  }
  throw new ComputerRuntimeActionError("unsupported_platform");
}

function parseMacPermissionSummary(stdout: string): ComputerPermissionSummary {
  let value: unknown;
  try {
    value = JSON.parse(stdout.trim());
  } catch {
    return unknownMacPermissionSummary("failed");
  }
  if (!isRecord(value) || value["ok"] === false || typeof value["error"] === "string") {
    return unknownMacPermissionSummary("failed");
  }
  const accessibility = booleanGrant(value["accessibility"]);
  const screenRecording = booleanGrant(value["screen_recording"]);
  const liveScreenCapture = booleanGrant(value["screen_recording_capturable"]);
  const screenReady = liveScreenCapture === "granted"
    || (liveScreenCapture === "unknown" && screenRecording === "granted");
  const status = accessibility === "granted" && screenReady ? "granted" : "missing";
  return {
    required: true,
    status,
    accessibility,
    screenRecording,
    liveScreenCapture,
    canGrant: true,
    passiveProbe: "supported"
  };
}

function unknownMacPermissionSummary(
  passiveProbe: Extract<ComputerPermissionSummary["passiveProbe"], "unsupported_version" | "daemon_unavailable" | "failed">
): ComputerPermissionSummary {
  return {
    required: true,
    status: "unknown",
    accessibility: "unknown",
    screenRecording: "unknown",
    liveScreenCapture: "unknown",
    canGrant: true,
    passiveProbe
  };
}

function nonMacPermissionSummary(platform: ComputerHostPlatform): ComputerPermissionSummary {
  const supported = platform !== "unsupported";
  return {
    required: false,
    status: supported ? "not_required" : "unknown",
    accessibility: supported ? "not_required" : "unknown",
    screenRecording: supported ? "not_required" : "unknown",
    liveScreenCapture: supported ? "not_required" : "unknown",
    canGrant: false,
    passiveProbe: "not_required"
  };
}

function unavailableStatus(
  platform: ComputerPlatformSummary,
  issue: NonNullable<ComputerRuntimeStatus["issue"]>
): ComputerRuntimeStatus {
  return {
    installed: false,
    platform,
    daemon: { state: "unknown" },
    permissions: platform.platform === "darwin"
      ? unknownMacPermissionSummary("daemon_unavailable")
      : nonMacPermissionSummary(platform.platform),
    issue
  };
}

function daemonProcessId(output: string): number | undefined {
  const match = output.match(/^\s*pid:\s*(\d+)\s*$/mu);
  if (match?.[1] === undefined) return undefined;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function normalizedVersion(output: string): string | undefined {
  const text = output.trim().replace(/[\u0000-\u001f\u007f]+/gu, " ").trim();
  if (text === "") return undefined;
  const match = text.match(/\b\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\b/u);
  return match?.[0] ?? text.slice(0, 128);
}

function semverCore(value: string): readonly [number, number, number] | undefined {
  const match = value.match(/(?:^|\s|v)(\d+)\.(\d+)\.(\d+)/u);
  if (match?.[1] === undefined || match[2] === undefined || match[3] === undefined) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function booleanGrant(value: unknown): ComputerPermissionGrant {
  if (value === true) return "granted";
  if (value === false) return "missing";
  return "unknown";
}

function actionResult(result: ComputerCommandResult, status: ComputerRuntimeStatus): ComputerExplicitActionResult {
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    stdoutTruncated: result.stdoutTruncated,
    stderrTruncated: result.stderrTruncated,
    status
  };
}

function emptyCommandResult(): ComputerCommandResult {
  return {
    stdout: "",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    exitCode: 0,
    signal: null
  };
}

function validatePlan(plan: ComputerCommandPlan): ComputerCommandPlan {
  if (plan.command.trim() === "" || plan.command.includes("\0") || plan.command.length > 32_768) {
    throw new TypeError("Computer action command plan is invalid.");
  }
  if (plan.arguments.some((argument) => argument.includes("\0") || argument.length > 1024 * 1024)) {
    throw new TypeError("Computer action command plan contains an invalid argument.");
  }
  const extraEnvironment = plan.extraEnvironment === undefined
    ? undefined
    : Object.fromEntries(Object.entries(plan.extraEnvironment));
  return {
    command: plan.command,
    arguments: [...plan.arguments],
    ...(extraEnvironment === undefined ? {} : { extraEnvironment })
  };
}

function boundedOptionalPath(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (value.trim() === "" || value.includes("\0") || value.length > 32_768) {
    throw new TypeError("Computer runtime executable path is invalid.");
  }
  return value;
}

function boundedTimeout(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 60 * 60 * 1_000) {
    throw new RangeError(`${label} must be between one millisecond and one hour.`);
  }
  return value;
}

function boundedDuration(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${label} is invalid.`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAbortError(value: unknown): boolean {
  return value instanceof Error && value.name === "AbortError";
}

export function computerDriverReleaseAssetName(
  version: string,
  platform: NodeJS.Platform = process.platform,
  architecture: string = machine()
): string | undefined {
  const stableVersion = validateStableVersion(version);
  const prefix = `cua-driver-rs-${stableVersion}`;
  if (platform === "darwin") return `${prefix}-darwin-universal.tar.gz`;
  const normalizedArchitecture = normalizeArchitecture(architecture)
    ?? (/^(?:|unknown)$/iu.test(architecture.trim())
      ? normalizeArchitecture(platform === "win32" ? process.env["PROCESSOR_ARCHITECTURE"] ?? "" : "")
        ?? normalizeArchitecture(process.arch)
      : undefined);
  if (platform === "linux") {
    if (normalizedArchitecture === "x64") return `${prefix}-linux-x86_64-binary.tar.gz`;
    if (normalizedArchitecture === "arm64") return `${prefix}-linux-arm64-binary.tar.gz`;
  }
  if (platform === "win32") {
    if (normalizedArchitecture === "x64") return `${prefix}-windows-x86_64.zip`;
    if (normalizedArchitecture === "arm64") return `${prefix}-windows-arm64.zip`;
  }
  return undefined;
}

function normalizeArchitecture(value: string): "x64" | "arm64" | undefined {
  const normalized = value.trim().toLowerCase();
  if (normalized === "x64" || normalized === "x86_64" || normalized === "amd64") return "x64";
  if (normalized === "arm64" || normalized === "aarch64") return "arm64";
  return undefined;
}

function resolvedHostArchitecture(platform: NodeJS.Platform, environment: NodeJS.ProcessEnv): string {
  const native = machine();
  if (normalizeArchitecture(native) !== undefined) return native;
  if (!/^(?:|unknown)$/iu.test(native.trim())) return native;
  if (platform === "win32") {
    const environmentArchitecture = environment["PROCESSOR_ARCHITECTURE"];
    if (environmentArchitecture !== undefined && normalizeArchitecture(environmentArchitecture) !== undefined) {
      return environmentArchitecture;
    }
  }
  return process.arch;
}

function validateStableVersion(value: string): string {
  if (!/^\d+\.\d+\.\d+$/u.test(value)) throw new TypeError("Computer driver version is invalid.");
  return value;
}

function versionFromTag(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.startsWith(DRIVER_TAG_PREFIX)) return undefined;
  const version = value.slice(DRIVER_TAG_PREFIX.length);
  return /^\d+\.\d+\.\d+$/u.test(version) ? version : undefined;
}

async function fetchDriverVersions(
  fetchImpl: typeof fetch,
  signal: AbortSignal | undefined,
  headers: Readonly<Record<string, string>>
): Promise<readonly string[]> {
  const versions: string[] = [];
  for (let page = 1; page <= 10; page += 1) {
    const response = await fetchImpl(`${DRIVER_TAGS_URL}?per_page=100&page=${page}`, {
      headers,
      signal: updateSignal(signal)
    });
    if (!response.ok) throw new Error("Computer driver update catalog is unavailable.");
    const payload: unknown = await response.json();
    if (!Array.isArray(payload)) throw new Error("Computer driver update catalog is invalid.");
    if (payload.length === 0) break;
    for (const item of payload) {
      if (!isRecord(item) || typeof item["ref"] !== "string") continue;
      const tag = item["ref"].startsWith("refs/tags/") ? item["ref"].slice(10) : item["ref"];
      const version = versionFromTag(tag);
      if (version !== undefined) versions.push(version);
    }
    if (payload.length < 100) break;
  }
  return [...new Set(versions)].sort((left, right) => compareSemver(right, left));
}

interface InstallableDriverRelease {
  readonly version: string;
  readonly assetName: string;
  readonly assetSize: number;
}

class DriverReleaseHttpError extends Error {
  constructor(readonly status: number) {
    super("Computer driver release could not be verified.");
    this.name = "DriverReleaseHttpError";
  }
}

async function fetchInstallableRelease(
  version: string,
  platform: NodeJS.Platform,
  architecture: string,
  fetchImpl: typeof fetch,
  signal: AbortSignal | undefined,
  headers: Readonly<Record<string, string>>
): Promise<InstallableDriverRelease | undefined> {
  const stableVersion = validateStableVersion(version);
  const response = await fetchImpl(`${DRIVER_RELEASE_URL}/${DRIVER_TAG_PREFIX}${stableVersion}`, {
    headers,
    signal: updateSignal(signal)
  });
  if (response.status === 404) return undefined;
  if (!response.ok) throw new DriverReleaseHttpError(response.status);
  const payload: unknown = await response.json();
  if (!isRecord(payload) || payload["draft"] === true || versionFromTag(payload["tag_name"]) !== stableVersion) {
    return undefined;
  }
  const assetName = computerDriverReleaseAssetName(stableVersion, platform, architecture);
  if (assetName === undefined || !Array.isArray(payload["assets"])) return undefined;
  for (const asset of payload["assets"]) {
    if (
      isRecord(asset)
      && asset["name"] === assetName
      && asset["state"] === "uploaded"
      && typeof asset["size"] === "number"
      && Number.isSafeInteger(asset["size"])
      && asset["size"] > 0
    ) return { version: stableVersion, assetName, assetSize: asset["size"] };
  }
  return undefined;
}

function githubHeaders(environment: NodeJS.ProcessEnv): Record<string, string> {
  const token = boundedSecret(environment["GITHUB_TOKEN"] ?? environment["GH_TOKEN"]);
  return {
    Accept: "application/vnd.github+json",
    "User-Agent": "joko-computer-automation",
    ...(token === undefined ? {} : { Authorization: `Bearer ${token}` })
  };
}

function computerUpdateFetch(
  environment: NodeJS.ProcessEnv,
  resolveOutboundProxy: ComputerOutboundProxyResolver | undefined
): {
  readonly fetchImpl: typeof fetch;
  readonly dispatchers: ReadonlySet<Dispatcher>;
} {
  const noProxy = boundedNoProxy(environment["NO_PROXY"] ?? environment["no_proxy"]);
  const environmentConfigured = hasProxyEnvironment(environment);
  const dispatcherByProxy = new Map<string, Dispatcher>();
  const dispatchers = new Set<Dispatcher>();
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const target = requestUrl(input);
    let proxyUrl: string | undefined;
    if (target !== undefined && !(environmentConfigured && proxyBypassed(target, noProxy))) {
      proxyUrl = environmentConfigured
        ? environmentProxyForUrl(environment, target)
        : validInstallerProxy(await resolveOutboundProxySafely(
            resolveOutboundProxy,
            target.toString(),
            requestSignal(init?.signal)
          ));
    }
    let dispatcher: Dispatcher | undefined;
    if (proxyUrl !== undefined) {
      dispatcher = dispatcherByProxy.get(proxyUrl);
      if (dispatcher === undefined) {
        dispatcher = createUpdateProxyDispatcher(proxyUrl);
        dispatcherByProxy.set(proxyUrl, dispatcher);
        dispatchers.add(dispatcher);
      }
    }
    return await proxyFetch(input as Parameters<typeof proxyFetch>[0], {
      ...(init as Parameters<typeof proxyFetch>[1]),
      ...(dispatcher === undefined ? {} : { dispatcher })
    }) as unknown as Response;
  }) as typeof fetch;
  return { fetchImpl, dispatchers };
}

function environmentProxyForUrl(environment: NodeJS.ProcessEnv, target: URL): string | undefined {
  const candidates = target.protocol === "https:"
    ? [
        environment["HTTPS_PROXY"],
        environment["https_proxy"],
        environment["ALL_PROXY"],
        environment["all_proxy"]
      ]
    : [
        environment["HTTP_PROXY"],
        environment["http_proxy"],
        environment["ALL_PROXY"],
        environment["all_proxy"]
      ];
  const configured = candidates.find((value): value is string => value !== undefined && value !== "");
  return validInstallerProxy(configured);
}

function createUpdateProxyDispatcher(proxyUrl: string): Dispatcher {
  const protocol = new URL(proxyUrl).protocol;
  return protocol === "socks5:" || protocol === "socks5h:"
    ? createSocks5Dispatcher(proxyUrl)
    : new ProxyAgent(proxyUrl);
}

function hasProxyEnvironment(environment: NodeJS.ProcessEnv): boolean {
  return [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "http_proxy",
    "https_proxy",
    "ALL_PROXY",
    "all_proxy"
  ].some((key) => typeof environment[key] === "string" && environment[key] !== "");
}

function requestSignal(value: AbortSignal | null | undefined): AbortSignal | undefined {
  return value instanceof AbortSignal ? value : undefined;
}

async function resolveOutboundProxySafely(
  resolver: ComputerOutboundProxyResolver | undefined,
  upstreamUrl: string,
  signal: AbortSignal | undefined
): Promise<string | undefined> {
  if (resolver === undefined) return undefined;
  if (signal?.aborted === true) throw new DOMException("Cancelled", "AbortError");
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  const stopped = new Promise<undefined>((resolve, reject) => {
    timer = setTimeout(resolve, 2_000, undefined);
    timer.unref?.();
    if (signal !== undefined) {
      onAbort = () => reject(new DOMException("Cancelled", "AbortError"));
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
  try {
    const value = await Promise.race([
      Promise.resolve(resolver(upstreamUrl, { signal })),
      stopped
    ]);
    return typeof value === "string" ? value : undefined;
  } catch (error) {
    if (isAbortError(error) || signalAborted(signal)) throw error;
    return undefined;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);
  }
}

function signalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function installerProxyEnvironment(value: string | undefined): Readonly<Record<string, string>> | undefined {
  const proxy = validInstallerProxy(value);
  if (proxy === undefined) return undefined;
  const protocol = new URL(proxy).protocol;
  if (protocol === "socks5:" || protocol === "socks5h:") {
    const remoteDnsProxy = proxy.replace(/^socks5:/u, "socks5h:");
    return { ALL_PROXY: remoteDnsProxy, all_proxy: remoteDnsProxy };
  }
  return {
    HTTP_PROXY: proxy,
    HTTPS_PROXY: proxy,
    http_proxy: proxy,
    https_proxy: proxy
  };
}

function requestUrl(input: RequestInfo | URL): URL | undefined {
  try {
    if (input instanceof URL) return input;
    if (typeof input === "string") return new URL(input);
    return new URL(input.url);
  } catch {
    return undefined;
  }
}

function proxyBypassed(target: URL, noProxy: string | undefined): boolean {
  if (noProxy === undefined) return false;
  const hostname = target.hostname.toLowerCase();
  const port = target.port || (target.protocol === "https:" ? "443" : "80");
  return noProxy.split(",").some((entry) => {
    const value = entry.trim().toLowerCase();
    if (value === "*") return true;
    if (value === "") return false;
    const colon = value.lastIndexOf(":");
    const hasPort = colon > 0 && /^\d+$/u.test(value.slice(colon + 1));
    const host = (hasPort ? value.slice(0, colon) : value).replace(/^\./u, "");
    if (hasPort && value.slice(colon + 1) !== port) return false;
    return hostname === host || hostname.endsWith(`.${host}`);
  });
}

function installerEnvironment(environment: NodeJS.ProcessEnv): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const key of [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "http_proxy",
    "https_proxy",
    "ALL_PROXY",
    "all_proxy"
  ] as const) {
    const value = validInstallerProxy(environment[key]);
    if (value !== undefined) result[key] = value;
  }
  for (const key of ["NO_PROXY", "no_proxy"] as const) {
    const value = boundedNoProxy(environment[key]);
    if (value !== undefined) result[key] = value;
  }
  return result;
}

function validInstallerProxy(value: string | undefined): string | undefined {
  if (value === undefined || value.length > 16 * 1024 || /[\0\r\n]/u.test(value)) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "http:"
      || url.protocol === "https:"
      || url.protocol === "socks5:"
      || url.protocol === "socks5h:"
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

function boundedNoProxy(value: string | undefined): string | undefined {
  return value !== undefined && value !== "" && value.length <= 16 * 1024 && !/[\0\r\n]/u.test(value)
    ? value
    : undefined;
}

function boundedSecret(value: string | undefined): string | undefined {
  return value !== undefined && value !== "" && value.length <= 4_096 && !/[\0\r\n\s]/u.test(value)
    ? value
    : undefined;
}

function updateSignal(signal: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(UPDATE_CHECK_TIMEOUT_MS);
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
}

function abortableDelay(milliseconds: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted === true) return Promise.reject(new DOMException("Cancelled", "AbortError"));
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new DOMException("Cancelled", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function actionErrorMessage(code: ComputerRuntimeActionError["code"]): string {
  if (code === "unsupported_platform") return "Computer automation is unavailable on this platform.";
  if (code === "not_installed") return "Computer automation runtime is not installed.";
  if (code === "install_failed") return "Computer automation runtime installation failed.";
  if (code === "permission_grant_failed") return "Computer automation permission grant failed.";
  if (code === "permission_settings_failed") return "Computer system permission settings could not be opened.";
  if (code === "no_verified_update") return "No verified computer automation update is available.";
  return "Computer automation runtime update failed.";
}
