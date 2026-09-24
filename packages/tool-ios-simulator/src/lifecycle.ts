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
  | "SIMULATOR_CONTROL_FAILED" | "SIMULATOR_CONTROL_UNKNOWN";

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
}

export type SimulatorAppearance = "light" | "dark";
export type SimulatorContentSize = "extra-small" | "small" | "medium" | "large" | "extra-large" |
  "extra-extra-large" | "extra-extra-extra-large" | "accessibility-medium" |
  "accessibility-large" | "accessibility-extra-large" | "accessibility-extra-extra-large" |
  "accessibility-extra-extra-extra-large";

const CONTENT_SIZES = new Set<SimulatorContentSize>([
  "extra-small", "small", "medium", "large", "extra-large", "extra-extra-large",
  "extra-extra-extra-large", "accessibility-medium", "accessibility-large",
  "accessibility-extra-large", "accessibility-extra-extra-large",
  "accessibility-extra-extra-extra-large"
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
    }
  };
}
