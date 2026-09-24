import { createNodeSimulatorCommandRunner, parseSimulatorListJson,
  type SimulatorCommandResult, type SimulatorCommandRunner, type SimulatorDevice } from "./environment.js";

const XCRUN = "/usr/bin/xcrun";
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu;
const IOS_RUNTIME = /^com\.apple\.CoreSimulator\.SimRuntime\.iOS-[A-Za-z0-9._-]{1,128}$/u;
const DEVICE_TYPE = /^com\.apple\.CoreSimulator\.SimDeviceType\.[A-Za-z0-9._-]{1,128}$/u;

export interface SimulatorOwnedDeleteIdentity {
  readonly udid: string;
  readonly name: string;
  readonly runtimeIdentifier: string;
  readonly deviceTypeIdentifier: string;
}

export class SimulatorDeleteError extends Error {
  constructor(readonly code: "UNSUPPORTED_PLATFORM" | "INVALID_ARGUMENT" | "DEVICE_IDENTITY_CHANGED" |
    "DEVICE_NOT_SHUTDOWN" | "SIMCTL_FAILED" | "SIMULATOR_DELETE_FAILED" |
    "SIMULATOR_DELETE_UNKNOWN", message: string) { super(message); }
}

export interface SimulatorOwnedDeleteRuntime {
  deleteExact(input: SimulatorOwnedDeleteIdentity, signal?: AbortSignal): Promise<void>;
}

/** Delete only an exact, already shut down Store-owned device; absence is an idempotent terminal observation. */
export function createSimulatorOwnedDeleteRuntime(options: {
  readonly platform?: NodeJS.Platform;
  readonly runner?: SimulatorCommandRunner;
} = {}): SimulatorOwnedDeleteRuntime {
  const platform = options.platform ?? process.platform;
  const runner = options.runner ?? createNodeSimulatorCommandRunner();

  async function catalog(signal?: AbortSignal): Promise<readonly SimulatorDevice[]> {
    let result: SimulatorCommandResult;
    try { result = await runner.run(XCRUN, ["simctl", "list", "-j"], { signal, timeoutMs: 15_000 }); }
    catch { throw new SimulatorDeleteError("SIMCTL_FAILED", "Simulator device state could not be read."); }
    if (result.exitCode !== 0 || result.failed || result.timedOut || result.aborted ||
        result.outputTruncated || signal?.aborted) throw new SimulatorDeleteError(
      "SIMCTL_FAILED", "Simulator device state could not be read.");
    try {
      const devices = parseSimulatorListJson(result.stdout).devices;
      if (new Set(devices.map(device => device.udid.toUpperCase())).size !== devices.length) {
        throw new Error("Duplicate Simulator device.");
      }
      return devices;
    } catch { throw new SimulatorDeleteError("SIMCTL_FAILED", "Simulator device state was invalid."); }
  }

  return { async deleteExact(input, signal) {
    if (platform !== "darwin") throw new SimulatorDeleteError(
      "UNSUPPORTED_PLATFORM", "iOS Simulator requires a local macOS host.");
    if (!UUID.test(input.udid) || !IOS_RUNTIME.test(input.runtimeIdentifier) ||
        !DEVICE_TYPE.test(input.deviceTypeIdentifier) || typeof input.name !== "string" ||
        input.name.length < 1 || input.name.length > 128 || input.name.trim() !== input.name ||
        /[\u0000-\u001f\u007f]/u.test(input.name)) throw new SimulatorDeleteError(
      "INVALID_ARGUMENT", "Simulator deletion identity is invalid.");
    const udid = input.udid.toUpperCase();
    const before = (await catalog(signal)).find(device => device.udid.toUpperCase() === udid);
    if (!before) return;
    if (before.name !== input.name || before.runtimeIdentifier !== input.runtimeIdentifier ||
        before.deviceTypeIdentifier !== input.deviceTypeIdentifier) throw new SimulatorDeleteError(
      "DEVICE_IDENTITY_CHANGED", "Simulator device identity changed before deletion.");
    if (before.state.toLowerCase() !== "shutdown") throw new SimulatorDeleteError(
      "DEVICE_NOT_SHUTDOWN", "Simulator must be shut down before deletion.");
    if (signal?.aborted) throw new SimulatorDeleteError(
      "SIMULATOR_DELETE_UNKNOWN", "Simulator deletion was cancelled before dispatch.");
    let result: SimulatorCommandResult | undefined;
    try { result = await runner.run(XCRUN, ["simctl", "delete", udid], { signal, timeoutMs: 30_000 }); }
    catch { /* Independent observation decides whether the command deleted the exact device. */ }
    let after: SimulatorDevice | undefined;
    try { after = (await catalog()).find(device => device.udid.toUpperCase() === udid); }
    catch { throw new SimulatorDeleteError("SIMULATOR_DELETE_UNKNOWN",
      "Simulator deletion could not be confirmed."); }
    if (!after) return;
    if (after.name !== input.name || after.runtimeIdentifier !== input.runtimeIdentifier ||
        after.deviceTypeIdentifier !== input.deviceTypeIdentifier) throw new SimulatorDeleteError(
      "DEVICE_IDENTITY_CHANGED", "Simulator device identity changed during deletion.");
    if (result && result.exitCode !== 0 && !result.failed && !result.timedOut &&
        !result.aborted && !result.outputTruncated) throw new SimulatorDeleteError(
      "SIMULATOR_DELETE_FAILED", "Simulator could not be deleted.");
    throw new SimulatorDeleteError("SIMULATOR_DELETE_UNKNOWN", "Simulator deletion could not be confirmed.");
  } };
}
