import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, isAbsolute, join } from "node:path";
import {
  createNodeSimulatorCommandRunner, parseSimulatorListJson,
  type SimulatorCommandResult, type SimulatorCommandRunner, type SimulatorDevice
} from "./environment.js";

const XCRUN = "/usr/bin/xcrun";
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

export type SimulatorLifecycleErrorCode =
  | "UNSUPPORTED_PLATFORM" | "INVALID_ARGUMENT" | "MUTATION_CANCELLED"
  | "SIMCTL_FAILED" | "INVALID_SIMCTL_OUTPUT" | "SIMULATOR_NOT_FOUND"
  | "SIMULATOR_BOOT_FAILED" | "SIMULATOR_BOOT_TIMEOUT" | "SIMULATOR_BOOT_UNKNOWN"
  | "SIMULATOR_SHUTDOWN_FAILED" | "SIMULATOR_SHUTDOWN_TIMEOUT" | "SIMULATOR_SHUTDOWN_UNKNOWN"
  | "SIMULATOR_CONTROL_FAILED" | "SIMULATOR_CONTROL_UNKNOWN"
  | "APP_INSTALL_FAILED" | "APP_INSTALL_UNKNOWN"
  | "APP_LAUNCH_FAILED" | "APP_LAUNCH_UNKNOWN"
  | "APP_TERMINATE_FAILED" | "APP_TERMINATE_UNKNOWN";

export class SimulatorLifecycleError extends Error {
  constructor(readonly code: SimulatorLifecycleErrorCode, message: string) { super(message); }
}

export interface SimulatorLifecycleRuntime {
  findExact(udid: string, signal?: AbortSignal): Promise<SimulatorDevice | null>;
  bootExact(udid: string, signal?: AbortSignal): Promise<SimulatorDevice>;
  shutdownExact(udid: string, signal?: AbortSignal): Promise<void>;
  setAppearance?(udid: string, appearance: SimulatorAppearance, signal?: AbortSignal): Promise<void>;
  setIncreaseContrast?(udid: string, enabled: boolean, signal?: AbortSignal): Promise<void>;
  setContentSize?(udid: string, contentSize: SimulatorContentSize, signal?: AbortSignal): Promise<void>;
  setLocation?(udid: string, latitude: number, longitude: number, signal?: AbortSignal): Promise<void>;
  startLocationRoute?(udid: string, options: SimulatorLocationRouteOptions,
    signal?: AbortSignal): Promise<void>;
  clearLocation?(udid: string, signal?: AbortSignal): Promise<void>;
  setPrivacy?(udid: string, action: SimulatorPrivacyAction, service: string,
    bundleId?: string, signal?: AbortSignal): Promise<void>;
  setStatusBar?(udid: string, overrides: SimulatorStatusBarOverrides,
    signal?: AbortSignal): Promise<void>;
  clearStatusBar?(udid: string, signal?: AbortSignal): Promise<void>;
  pushNotification?(udid: string, bundleId: string,
    payload: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<void>;
  installApp?(udid: string, appPath: string, signal?: AbortSignal): Promise<void>;
  launchApp?(udid: string, bundleId: string, args: readonly string[],
    signal?: AbortSignal): Promise<void>;
  terminateApp?(udid: string, bundleId: string, signal?: AbortSignal): Promise<void>;
}

export type SimulatorAppearance = "light" | "dark";
export type SimulatorContentSize = "extra-small" | "small" | "medium" | "large" | "extra-large" |
  "extra-extra-large" | "extra-extra-extra-large" | "accessibility-medium" |
  "accessibility-large" | "accessibility-extra-large" | "accessibility-extra-extra-large" |
  "accessibility-extra-extra-extra-large";
export interface SimulatorLocationWaypoint {
  readonly latitude: number;
  readonly longitude: number;
}
export interface SimulatorLocationRouteOptions {
  readonly waypoints: readonly SimulatorLocationWaypoint[];
  readonly speedMetersPerSecond?: number;
  readonly intervalSeconds?: number;
  readonly distanceMeters?: number;
}
export type SimulatorPrivacyAction = "grant" | "revoke" | "reset";
export type SimulatorStatusBarDataNetwork = "hide" | "wifi" | "3g" | "4g" | "lte" |
  "lte-a" | "lte+" | "5g" | "5g+" | "5g-uwb" | "5g-uc";
export type SimulatorStatusBarWifiMode = "searching" | "failed" | "active";
export type SimulatorStatusBarCellularMode = "notSupported" | "searching" | "failed" | "active";
export type SimulatorStatusBarBatteryState = "charging" | "charged" | "discharging";
export interface SimulatorStatusBarOverrides {
  readonly time?: string;
  readonly dataNetwork?: SimulatorStatusBarDataNetwork;
  readonly wifiMode?: SimulatorStatusBarWifiMode;
  readonly wifiBars?: number;
  readonly cellularMode?: SimulatorStatusBarCellularMode;
  readonly cellularBars?: number;
  readonly operatorName?: string;
  readonly batteryState?: SimulatorStatusBarBatteryState;
  readonly batteryLevel?: number;
}

const CONTENT_SIZES = new Set<SimulatorContentSize>([
  "extra-small", "small", "medium", "large", "extra-large", "extra-extra-large",
  "extra-extra-extra-large", "accessibility-medium", "accessibility-large",
  "accessibility-extra-large", "accessibility-extra-extra-large",
  "accessibility-extra-extra-extra-large"
]);
const LOCATION_ROUTE_LIMITS = Object.freeze({
  speedMetersPerSecond: 10_000,
  intervalSeconds: 86_400,
  distanceMeters: 10_000_000
});
const PRIVACY_SERVICE = /^[a-z][a-z0-9-]{0,63}$/u;
const BUNDLE_ID = /^[A-Za-z0-9][A-Za-z0-9.-]{1,254}$/u;

/** Validate the exact JSON body that can be sent to simctl without silent field loss. */
export function serializeSimulatorPushPayload(payload: unknown): string {
  const seen = new WeakSet<object>();
  const visit = (value: unknown): boolean => {
    if (value === null || typeof value === "string" || typeof value === "boolean") return true;
    if (typeof value === "number") return Number.isFinite(value);
    if (typeof value !== "object" || seen.has(value)) return false;
    seen.add(value);
    let valid: boolean;
    if (Array.isArray(value)) valid = value.every(visit);
    else {
      const prototype = Object.getPrototypeOf(value);
      valid = (prototype === Object.prototype || prototype === null) &&
        Object.getOwnPropertySymbols(value).length === 0 &&
        Object.keys(value).every(key => visit((value as Record<string, unknown>)[key]));
    }
    seen.delete(value);
    return valid;
  };
  try {
    if (!payload || typeof payload !== "object" || Array.isArray(payload) ||
        !Object.prototype.hasOwnProperty.call(payload, "aps") ||
        !(payload as Record<string, unknown>)["aps"] || !visit(payload)) {
      throw new Error("Invalid payload.");
    }
    const serialized = JSON.stringify(payload);
    if (typeof serialized !== "string" || Buffer.byteLength(serialized, "utf8") > 4_096) {
      throw new Error("Invalid payload size.");
    }
    return serialized;
  } catch {
    throw new SimulatorLifecycleError("INVALID_ARGUMENT", "Simulator push payload is invalid.");
  }
}
const STATUS_BAR_KEYS = new Set([
  "time", "dataNetwork", "wifiMode", "wifiBars", "cellularMode", "cellularBars",
  "operatorName", "batteryState", "batteryLevel"
]);
const STATUS_BAR_DATA_NETWORKS = new Set<SimulatorStatusBarDataNetwork>([
  "hide", "wifi", "3g", "4g", "lte", "lte-a", "lte+", "5g", "5g+", "5g-uwb", "5g-uc"
]);
const STATUS_BAR_WIFI_MODES = new Set<SimulatorStatusBarWifiMode>([
  "searching", "failed", "active"
]);
const STATUS_BAR_CELLULAR_MODES = new Set<SimulatorStatusBarCellularMode>([
  "notSupported", "searching", "failed", "active"
]);
const STATUS_BAR_BATTERY_STATES = new Set<SimulatorStatusBarBatteryState>([
  "charging", "charged", "discharging"
]);

export interface SimulatorLifecycleClock {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

function defaultClock(): SimulatorLifecycleClock {
  return {
    now: Date.now,
    sleep: (ms, signal) => new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(signal.reason); return; }
      const onAbort = (): void => { clearTimeout(timer); reject(signal?.reason); };
      const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
      signal?.addEventListener("abort", onAbort, { once: true });
    })
  };
}

function exactUdid(value: string): string {
  if (typeof value !== "string" || !UUID.test(value)) throw new SimulatorLifecycleError("INVALID_ARGUMENT", "Simulator UDID is invalid.");
  return value.toUpperCase();
}

function cancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new SimulatorLifecycleError("MUTATION_CANCELLED", "Simulator operation was cancelled.");
}

function commandUnknown(result: SimulatorCommandResult): boolean {
  return result.timedOut === true || result.aborted === true || result.outputTruncated === true;
}

function statusBarArguments(overrides: SimulatorStatusBarOverrides): string[] {
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides) ||
      Object.keys(overrides).some(key => !STATUS_BAR_KEYS.has(key))) {
    throw new SimulatorLifecycleError("INVALID_ARGUMENT", "Simulator status-bar overrides are invalid.");
  }
  const args: string[] = [];
  const add = (key: string, value: string | number | undefined): void => {
    if (value !== undefined) args.push(`--${key}`, String(value));
  };
  if (overrides.time !== undefined) {
    if (typeof overrides.time !== "string" || !overrides.time.trim() ||
        overrides.time.length > 128 || /[\0\r\n]/u.test(overrides.time)) {
      throw new SimulatorLifecycleError("INVALID_ARGUMENT", "Simulator status-bar time is invalid.");
    }
    add("time", overrides.time);
  }
  if (overrides.dataNetwork !== undefined &&
      !STATUS_BAR_DATA_NETWORKS.has(overrides.dataNetwork)) {
    throw new SimulatorLifecycleError("INVALID_ARGUMENT",
      "Simulator status-bar data network is invalid.");
  }
  add("dataNetwork", overrides.dataNetwork);
  if (overrides.wifiMode !== undefined && !STATUS_BAR_WIFI_MODES.has(overrides.wifiMode)) {
    throw new SimulatorLifecycleError("INVALID_ARGUMENT", "Simulator status-bar Wi-Fi mode is invalid.");
  }
  add("wifiMode", overrides.wifiMode);
  if (overrides.cellularMode !== undefined &&
      !STATUS_BAR_CELLULAR_MODES.has(overrides.cellularMode)) {
    throw new SimulatorLifecycleError("INVALID_ARGUMENT",
      "Simulator status-bar cellular mode is invalid.");
  }
  add("cellularMode", overrides.cellularMode);
  if (overrides.wifiBars !== undefined && (!Number.isInteger(overrides.wifiBars) ||
      overrides.wifiBars < 0 || overrides.wifiBars > 3)) {
    throw new SimulatorLifecycleError("INVALID_ARGUMENT", "Simulator status-bar Wi-Fi bars are invalid.");
  }
  add("wifiBars", overrides.wifiBars);
  if (overrides.cellularBars !== undefined && (!Number.isInteger(overrides.cellularBars) ||
      overrides.cellularBars < 0 || overrides.cellularBars > 4)) {
    throw new SimulatorLifecycleError("INVALID_ARGUMENT",
      "Simulator status-bar cellular bars are invalid.");
  }
  add("cellularBars", overrides.cellularBars);
  if (overrides.operatorName !== undefined) {
    if (typeof overrides.operatorName !== "string" || overrides.operatorName.length > 128 ||
        /[\0\r\n]/u.test(overrides.operatorName)) {
      throw new SimulatorLifecycleError("INVALID_ARGUMENT",
        "Simulator status-bar operator name is invalid.");
    }
    add("operatorName", overrides.operatorName);
  }
  if (overrides.batteryState !== undefined &&
      !STATUS_BAR_BATTERY_STATES.has(overrides.batteryState)) {
    throw new SimulatorLifecycleError("INVALID_ARGUMENT",
      "Simulator status-bar battery state is invalid.");
  }
  add("batteryState", overrides.batteryState);
  if (overrides.batteryLevel !== undefined && (!Number.isInteger(overrides.batteryLevel) ||
      overrides.batteryLevel < 0 || overrides.batteryLevel > 100)) {
    throw new SimulatorLifecycleError("INVALID_ARGUMENT",
      "Simulator status-bar battery level is invalid.");
  }
  add("batteryLevel", overrides.batteryLevel);
  if (args.length === 0) {
    throw new SimulatorLifecycleError("INVALID_ARGUMENT",
      "At least one Simulator status-bar override is required.");
  }
  return args;
}

/** Exact-UDID simctl lifecycle I/O. External effects are admitted by the caller. */
export function createSimulatorLifecycleRuntime(options: {
  readonly platform?: NodeJS.Platform;
  readonly runner?: SimulatorCommandRunner;
  readonly clock?: SimulatorLifecycleClock;
  readonly bootTimeoutMs?: number;
  readonly shutdownTimeoutMs?: number;
  readonly pollIntervalMs?: number;
} = {}): SimulatorLifecycleRuntime {
  const platform = options.platform ?? process.platform;
  const runner = options.runner ?? createNodeSimulatorCommandRunner();
  const clock = options.clock ?? defaultClock();
  const bootTimeoutMs = options.bootTimeoutMs ?? 120_000;
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? 60_000;
  const pollIntervalMs = options.pollIntervalMs ?? 1_000;
  if (![bootTimeoutMs, shutdownTimeoutMs, pollIntervalMs].every(value => Number.isSafeInteger(value) && value > 0 && value <= 180_000)) {
    throw new RangeError("Simulator lifecycle timeout is invalid.");
  }

  function requirePlatform(): void {
    if (platform !== "darwin") throw new SimulatorLifecycleError("UNSUPPORTED_PLATFORM", "iOS Simulator requires a local macOS host.");
  }

  async function list(signal?: AbortSignal): Promise<readonly SimulatorDevice[]> {
    requirePlatform();
    cancelled(signal);
    let result: SimulatorCommandResult;
    try { result = await runner.run(XCRUN, ["simctl", "list", "-j"], { signal }); }
    catch {
      cancelled(signal);
      throw new SimulatorLifecycleError("SIMCTL_FAILED", "Simulator device state could not be read.");
    }
    cancelled(signal);
    if (result.exitCode !== 0 || result.failed || result.timedOut || result.aborted || result.outputTruncated) {
      throw new SimulatorLifecycleError("SIMCTL_FAILED", "Simulator device state could not be read.");
    }
    try { return parseSimulatorListJson(result.stdout).devices; }
    catch { throw new SimulatorLifecycleError("INVALID_SIMCTL_OUTPUT", "Simulator device state was invalid."); }
  }

  async function findExact(udid: string, signal?: AbortSignal): Promise<SimulatorDevice | null> {
    requirePlatform();
    const normalized = exactUdid(udid);
    return (await list(signal)).find(device => device.udid.toUpperCase() === normalized) ?? null;
  }

  async function runMutation(args: readonly string[], timeoutMs: number, unknownCode: SimulatorLifecycleErrorCode,
    signal?: AbortSignal): Promise<SimulatorCommandResult> {
    cancelled(signal);
    let result: SimulatorCommandResult;
    try { result = await runner.run(XCRUN, args, { signal, timeoutMs }); }
    catch { throw new SimulatorLifecycleError(unknownCode, "Simulator command outcome is unknown; refresh device state before retrying."); }
    if (commandUnknown(result) || signal?.aborted) {
      throw new SimulatorLifecycleError(unknownCode, "Simulator command outcome is unknown; refresh device state before retrying.");
    }
    return result;
  }

  async function runControl(udid: string, args: readonly string[], signal?: AbortSignal): Promise<void> {
    requirePlatform();
    const normalized = exactUdid(udid);
    const result = await runMutation(["simctl", "ui", normalized, ...args], 15_000,
      "SIMULATOR_CONTROL_UNKNOWN", signal);
    if (result.exitCode !== 0 || result.failed) {
      throw new SimulatorLifecycleError("SIMULATOR_CONTROL_FAILED",
        "Simulator system setting could not be changed.");
    }
  }

  async function runSimctlControl(udid: string, family: "location" | "privacy" | "status_bar",
    args: readonly string[],
    failureMessage: string, signal?: AbortSignal): Promise<void> {
    requirePlatform();
    const normalized = exactUdid(udid);
    const result = await runMutation(["simctl", family, normalized, ...args], 15_000,
      "SIMULATOR_CONTROL_UNKNOWN", signal);
    if (result.exitCode !== 0 || result.failed) {
      throw new SimulatorLifecycleError("SIMULATOR_CONTROL_FAILED", failureMessage);
    }
  }

  function locationWaypoint(latitude: number, longitude: number, label = "Simulator location"):
    SimulatorLocationWaypoint {
    if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
      throw new SimulatorLifecycleError("INVALID_ARGUMENT", `${label} latitude is invalid.`);
    }
    if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
      throw new SimulatorLifecycleError("INVALID_ARGUMENT", `${label} longitude is invalid.`);
    }
    return { latitude, longitude };
  }

  function locationRoute(options: SimulatorLocationRouteOptions): SimulatorLocationRouteOptions {
    if (!options || !Array.isArray(options.waypoints) ||
        options.waypoints.length < 2 || options.waypoints.length > 64) {
      throw new SimulatorLifecycleError("INVALID_ARGUMENT",
        "Simulator location route must contain between 2 and 64 waypoints.");
    }
    const waypoints = options.waypoints.map((waypoint, index) => {
      if (!waypoint || typeof waypoint !== "object") {
        throw new SimulatorLifecycleError("INVALID_ARGUMENT",
          `Simulator location waypoint ${index} is invalid.`);
      }
      return locationWaypoint(waypoint.latitude, waypoint.longitude,
        `Simulator location waypoint ${index}`);
    });
    for (const key of ["speedMetersPerSecond", "intervalSeconds", "distanceMeters"] as const) {
      const value = options[key];
      if (value !== undefined && (!Number.isFinite(value) || value <= 0 ||
          value > LOCATION_ROUTE_LIMITS[key])) {
        throw new SimulatorLifecycleError("INVALID_ARGUMENT",
          `Simulator location route ${key} is invalid.`);
      }
    }
    if (options.intervalSeconds !== undefined && options.distanceMeters !== undefined) {
      throw new SimulatorLifecycleError("INVALID_ARGUMENT",
        "Simulator location route accepts intervalSeconds or distanceMeters, not both.");
    }
    return { waypoints, speedMetersPerSecond: options.speedMetersPerSecond,
      intervalSeconds: options.intervalSeconds, distanceMeters: options.distanceMeters };
  }

  return {
    findExact,
    async bootExact(udid, signal) {
      requirePlatform();
      const normalized = exactUdid(udid);
      const before = await findExact(normalized, signal);
      if (!before) throw new SimulatorLifecycleError("SIMULATOR_NOT_FOUND", "Selected Simulator device no longer exists.");
      let dispatched = false;
      try {
        if (before.state.toLowerCase() !== "booted") {
          let starting = false;
          for (let attempt = 0; attempt < 2 && !starting; attempt += 1) {
            cancelled(signal);
            dispatched = true;
            const result = await runMutation(["simctl", "boot", normalized], 30_000, "SIMULATOR_BOOT_UNKNOWN", signal);
            if (result.exitCode === 0) { starting = true; break; }
            const observed = await findExact(normalized, signal);
            if (observed && ["booted", "booting"].includes(observed.state.toLowerCase())) { starting = true; break; }
            if (attempt === 0) await clock.sleep(500, signal);
          }
          if (!starting) throw new SimulatorLifecycleError("SIMULATOR_BOOT_FAILED", "Selected Simulator device could not be started.");
        }
        const deadline = clock.now() + bootTimeoutMs;
        while (clock.now() < deadline) {
          cancelled(signal);
          const device = await findExact(normalized, signal);
          if (!device) throw new SimulatorLifecycleError("SIMULATOR_NOT_FOUND", "Selected Simulator device disappeared while starting.");
          if (device.state.toLowerCase() === "booted") {
            dispatched = true;
            const result = await runMutation(["simctl", "bootstatus", normalized, "-b"],
              Math.max(1_000, Math.min(180_000, deadline - clock.now())), "SIMULATOR_BOOT_UNKNOWN", signal);
            if (result.failed) throw new SimulatorLifecycleError("SIMULATOR_BOOT_FAILED", "Simulator readiness could not be checked.");
            if (result.exitCode === 0) {
              const ready = await findExact(normalized, signal);
              if (!ready) throw new SimulatorLifecycleError("SIMULATOR_NOT_FOUND", "Selected Simulator device disappeared while starting.");
              if (ready.state.toLowerCase() === "booted") return ready;
            }
          }
          await clock.sleep(Math.min(pollIntervalMs, Math.max(1, deadline - clock.now())), signal);
        }
        throw new SimulatorLifecycleError("SIMULATOR_BOOT_TIMEOUT", "Selected Simulator device did not finish starting in time.");
      } catch (error) {
        if (signal?.aborted && dispatched && !(error instanceof SimulatorLifecycleError && error.code === "SIMULATOR_BOOT_UNKNOWN")) {
          throw new SimulatorLifecycleError("SIMULATOR_BOOT_UNKNOWN", "Simulator startup may have changed device state; refresh before retrying.");
        }
        if (signal?.aborted) throw new SimulatorLifecycleError("MUTATION_CANCELLED", "Simulator operation was cancelled.");
        if (error instanceof SimulatorLifecycleError) throw error;
        throw new SimulatorLifecycleError("SIMULATOR_BOOT_FAILED", "Selected Simulator device could not be started.");
      }
    },
    async shutdownExact(udid, signal) {
      requirePlatform();
      const normalized = exactUdid(udid);
      const before = await findExact(normalized, signal);
      if (!before) throw new SimulatorLifecycleError("SIMULATOR_NOT_FOUND", "Selected Simulator device no longer exists.");
      if (before.state.toLowerCase() === "shutdown") return;
      let dispatched = false;
      try {
        dispatched = true;
        const result = await runMutation(["simctl", "shutdown", normalized], 30_000, "SIMULATOR_SHUTDOWN_UNKNOWN", signal);
        if (result.exitCode !== 0) throw new SimulatorLifecycleError("SIMULATOR_SHUTDOWN_FAILED", "Selected Simulator device could not be stopped.");
        const deadline = clock.now() + shutdownTimeoutMs;
        while (clock.now() < deadline) {
          cancelled(signal);
          const observed = await findExact(normalized, signal);
          if (!observed) throw new SimulatorLifecycleError("SIMULATOR_NOT_FOUND", "Selected Simulator device disappeared while stopping.");
          if (observed.state.toLowerCase() === "shutdown") return;
          await clock.sleep(Math.min(pollIntervalMs, Math.max(1, deadline - clock.now())), signal);
        }
        throw new SimulatorLifecycleError("SIMULATOR_SHUTDOWN_TIMEOUT", "Selected Simulator device did not finish stopping in time.");
      } catch (error) {
        if (signal?.aborted && dispatched && !(error instanceof SimulatorLifecycleError && error.code === "SIMULATOR_SHUTDOWN_UNKNOWN")) {
          throw new SimulatorLifecycleError("SIMULATOR_SHUTDOWN_UNKNOWN", "Simulator shutdown may have changed device state; refresh before retrying.");
        }
        if (signal?.aborted) throw new SimulatorLifecycleError("MUTATION_CANCELLED", "Simulator operation was cancelled.");
        if (error instanceof SimulatorLifecycleError) throw error;
        throw new SimulatorLifecycleError("SIMULATOR_SHUTDOWN_FAILED", "Selected Simulator device could not be stopped.");
      }
    },
    async setAppearance(udid, appearance, signal) {
      if (appearance !== "light" && appearance !== "dark") {
        throw new SimulatorLifecycleError("INVALID_ARGUMENT", "Simulator appearance is invalid.");
      }
      await runControl(udid, ["appearance", appearance], signal);
    },
    async setIncreaseContrast(udid, enabled, signal) {
      if (typeof enabled !== "boolean") {
        throw new SimulatorLifecycleError("INVALID_ARGUMENT", "Simulator contrast setting is invalid.");
      }
      await runControl(udid, ["increase_contrast", enabled ? "enabled" : "disabled"], signal);
    },
    async setContentSize(udid, contentSize, signal) {
      if (!CONTENT_SIZES.has(contentSize)) {
        throw new SimulatorLifecycleError("INVALID_ARGUMENT", "Simulator content size is invalid.");
      }
      await runControl(udid, ["content_size", contentSize], signal);
    },
    async setLocation(udid, latitude, longitude, signal) {
      const point = locationWaypoint(latitude, longitude);
      await runSimctlControl(udid, "location", ["set", `${point.latitude},${point.longitude}`],
        "Simulator location could not be changed.", signal);
    },
    async startLocationRoute(udid, options, signal) {
      const route = locationRoute(options);
      const args = ["start"];
      if (route.speedMetersPerSecond !== undefined) {
        args.push(`--speed=${route.speedMetersPerSecond}`);
      }
      if (route.distanceMeters !== undefined) {
        args.push(`--distance=${route.distanceMeters}`);
      } else if (route.intervalSeconds !== undefined) {
        args.push(`--interval=${route.intervalSeconds}`);
      }
      args.push(...route.waypoints.map(point => `${point.latitude},${point.longitude}`));
      await runSimctlControl(udid, "location", args,
        "Simulator location route could not be started.", signal);
    },
    async clearLocation(udid, signal) {
      await runSimctlControl(udid, "location", ["clear"],
        "Simulator location could not be cleared.", signal);
    },
    async setPrivacy(udid, action, service, bundleId, signal) {
      if (action !== "grant" && action !== "revoke" && action !== "reset") {
        throw new SimulatorLifecycleError("INVALID_ARGUMENT", "Simulator privacy action is invalid.");
      }
      if (typeof service !== "string" || !PRIVACY_SERVICE.test(service)) {
        throw new SimulatorLifecycleError("INVALID_ARGUMENT", "Simulator privacy service is invalid.");
      }
      if (bundleId !== undefined && (typeof bundleId !== "string" || !BUNDLE_ID.test(bundleId))) {
        throw new SimulatorLifecycleError("INVALID_ARGUMENT", "Simulator bundle identity is invalid.");
      }
      if (action !== "reset" && bundleId === undefined) {
        throw new SimulatorLifecycleError("INVALID_ARGUMENT",
          "Simulator privacy grant and revoke require a bundle identity.");
      }
      await runSimctlControl(udid, "privacy", [action, service,
        ...(bundleId === undefined ? [] : [bundleId])],
        "Simulator privacy setting could not be changed.", signal);
    },
    async setStatusBar(udid, overrides, signal) {
      await runSimctlControl(udid, "status_bar", ["override", ...statusBarArguments(overrides)],
        "Simulator status bar could not be overridden.", signal);
    },
    async clearStatusBar(udid, signal) {
      await runSimctlControl(udid, "status_bar", ["clear"],
        "Simulator status bar override could not be cleared.", signal);
    },
    async installApp(udid, appPath, signal) {
      requirePlatform();
      const normalized = exactUdid(udid);
      if (typeof appPath !== "string" || !isAbsolute(appPath) ||
          extname(appPath).toLowerCase() !== ".app") {
        throw new SimulatorLifecycleError("INVALID_ARGUMENT", "Simulator app path is invalid.");
      }
      const result = await runMutation(["simctl", "install", normalized, appPath],
        120_000, "APP_INSTALL_UNKNOWN", signal);
      if (result.exitCode !== 0 || result.failed) {
        throw new SimulatorLifecycleError("APP_INSTALL_FAILED", "Simulator app could not be installed.");
      }
    },
    async launchApp(udid, bundleId, args, signal) {
      requirePlatform();
      const normalized = exactUdid(udid);
      if (typeof bundleId !== "string" || !BUNDLE_ID.test(bundleId) ||
          !Array.isArray(args) || args.length > 64 ||
          args.some(arg => typeof arg !== "string" || arg.length > 4_096 || /\0/u.test(arg))) {
        throw new SimulatorLifecycleError("INVALID_ARGUMENT", "Simulator app launch arguments are invalid.");
      }
      const result = await runMutation(["simctl", "launch", normalized, bundleId, ...args],
        30_000, "APP_LAUNCH_UNKNOWN", signal);
      if (result.exitCode !== 0 || result.failed) {
        throw new SimulatorLifecycleError("APP_LAUNCH_FAILED", "Simulator app could not be launched.");
      }
    },
    async terminateApp(udid, bundleId, signal) {
      requirePlatform();
      const normalized = exactUdid(udid);
      if (typeof bundleId !== "string" || !BUNDLE_ID.test(bundleId)) {
        throw new SimulatorLifecycleError("INVALID_ARGUMENT", "Simulator app bundle identity is invalid.");
      }
      const result = await runMutation(["simctl", "terminate", normalized, bundleId],
        30_000, "APP_TERMINATE_UNKNOWN", signal);
      if (result.exitCode !== 0 || result.failed) {
        throw new SimulatorLifecycleError("APP_TERMINATE_FAILED", "Simulator app could not be terminated.");
      }
    },
    async pushNotification(udid, bundleId, payload, signal) {
      requirePlatform();
      const normalized = exactUdid(udid);
      if (typeof bundleId !== "string" || !BUNDLE_ID.test(bundleId)) {
        throw new SimulatorLifecycleError("INVALID_ARGUMENT", "Simulator bundle identity is invalid.");
      }
      const serialized = serializeSimulatorPushPayload(payload);
      let tempRoot: string | undefined;
      let dispatched = false;
      try {
        cancelled(signal);
        tempRoot = await mkdtemp(join(tmpdir(), "joko-ios-push-"));
        cancelled(signal);
        const payloadPath = join(tempRoot, "payload.json");
        await writeFile(payloadPath, serialized, { encoding: "utf8", mode: 0o600, signal });
        cancelled(signal);
        dispatched = true;
        const result = await runMutation(["simctl", "push", normalized, bundleId, payloadPath],
          15_000, "SIMULATOR_CONTROL_UNKNOWN", signal);
        if (result.exitCode !== 0 || result.failed) {
          throw new SimulatorLifecycleError("SIMULATOR_CONTROL_FAILED",
            "Simulator push notification could not be delivered.");
        }
      } catch (error) {
        if (dispatched) {
          if (error instanceof SimulatorLifecycleError &&
              error.code === "SIMULATOR_CONTROL_FAILED") throw error;
          throw new SimulatorLifecycleError("SIMULATOR_CONTROL_UNKNOWN",
            "Simulator push outcome is unknown; inspect device state before retrying.");
        }
        if (signal?.aborted) {
          throw new SimulatorLifecycleError("MUTATION_CANCELLED",
            "Simulator push was cancelled before dispatch.");
        }
        if (error instanceof SimulatorLifecycleError) throw error;
        throw new SimulatorLifecycleError("SIMULATOR_CONTROL_FAILED",
          "Simulator push payload could not be prepared.");
      } finally {
        if (tempRoot) {
          try { await rm(tempRoot, { recursive: true, force: true }); }
          catch {
            throw new SimulatorLifecycleError(dispatched ? "SIMULATOR_CONTROL_UNKNOWN" :
              "SIMULATOR_CONTROL_FAILED", "Simulator push temporary payload could not be cleaned up.");
          }
        }
      }
    }
  };
}
