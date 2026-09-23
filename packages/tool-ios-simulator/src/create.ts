import { createNodeSimulatorCommandRunner, parseSimulatorListJson,
  type SimulatorCommandResult, type SimulatorCommandRunner, type SimulatorDevice } from "./environment.js";

const XCRUN = "/usr/bin/xcrun";
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const MARKER = /^joko_ios_pending__[0-9a-f]{32}__[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u;
const IOS_RUNTIME = /^com\.apple\.CoreSimulator\.SimRuntime\.iOS-[A-Za-z0-9._-]{1,128}$/u;
const DEVICE_TYPE = /^com\.apple\.CoreSimulator\.SimDeviceType\.[A-Za-z0-9._-]{1,128}$/u;

export type SimulatorCreateErrorCode = "UNSUPPORTED_PLATFORM" | "INVALID_ARGUMENT" | "MUTATION_CANCELLED"
  | "CREATE_EVIDENCE_FAILED" | "SIMULATOR_CREATE_FAILED" | "SIMULATOR_CREATE_UNKNOWN"
  | "SIMULATOR_CREATE_CLEANUP_REQUIRED" | "SIMULATOR_RENAME_FAILED" | "SIMULATOR_RENAME_UNKNOWN"
  | "SIMULATOR_DELETE_FAILED" | "SIMCTL_FAILED";

export class SimulatorCreateError extends Error {
  constructor(readonly code: SimulatorCreateErrorCode, message: string) { super(message); }
}

/** The caller persists the exact marker before create; it remains armed through ownership adoption and rename. */
export interface SimulatorPendingCreateEvidence {
  arm(markerName: string): void;
  clear(markerName: string): void;
}

export interface SimulatorCreateInput {
  readonly markerName: string;
  readonly runtimeIdentifier: string;
  readonly deviceTypeIdentifier: string;
}

export interface SimulatorCreatedDevice extends SimulatorCreateInput {
  readonly udid: string;
}

export interface SimulatorPendingDeviceIdentity extends SimulatorCreateInput {
  readonly udid: string;
}

export interface SimulatorCreateRuntime {
  createExact(input: SimulatorCreateInput, evidence: SimulatorPendingCreateEvidence, signal?: AbortSignal): Promise<SimulatorCreatedDevice>;
  findPendingMarker(markerName: string, signal?: AbortSignal): Promise<readonly SimulatorDevice[]>;
  renameExact(input: SimulatorPendingDeviceIdentity & { readonly name: string }, signal?: AbortSignal): Promise<void>;
  deletePendingExact(input: SimulatorPendingDeviceIdentity, signal?: AbortSignal): Promise<void>;
}

function validInput(input: SimulatorCreateInput): void {
  if (!MARKER.test(input.markerName) || !IOS_RUNTIME.test(input.runtimeIdentifier)
    || !DEVICE_TYPE.test(input.deviceTypeIdentifier)) {
    throw new SimulatorCreateError("INVALID_ARGUMENT", "Simulator creation identity is invalid.");
  }
}

function exactUdid(value: string): string {
  if (!UUID.test(value)) throw new SimulatorCreateError("INVALID_ARGUMENT", "Simulator UDID is invalid.");
  return value.toUpperCase();
}

function checkedName(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 128 || value.trim() !== value
    || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new SimulatorCreateError("INVALID_ARGUMENT", "Simulator name is invalid.");
  }
  return value;
}

function cancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new SimulatorCreateError("MUTATION_CANCELLED", "Simulator operation was cancelled.");
}

function commandUncertain(result: SimulatorCommandResult): boolean {
  return result.failed === true || result.timedOut === true || result.aborted === true || result.outputTruncated === true;
}

function samePending(device: SimulatorDevice, input: SimulatorPendingDeviceIdentity): boolean {
  return device.udid.toUpperCase() === input.udid && device.name === input.markerName
    && device.runtimeIdentifier === input.runtimeIdentifier
    && device.deviceTypeIdentifier === input.deviceTypeIdentifier;
}

/** Exact marker I/O. The service owns durable evidence, Operation claim and final ownership adoption. */
export function createSimulatorCreateRuntime(options: {
  readonly platform?: NodeJS.Platform;
  readonly runner?: SimulatorCommandRunner;
} = {}): SimulatorCreateRuntime {
  const platform = options.platform ?? process.platform;
  const runner = options.runner ?? createNodeSimulatorCommandRunner();

  function requirePlatform(): void {
    if (platform !== "darwin") throw new SimulatorCreateError("UNSUPPORTED_PLATFORM", "iOS Simulator requires a local macOS host.");
  }

  async function catalog(signal?: AbortSignal, timeoutMs = 15_000): Promise<readonly SimulatorDevice[]> {
    cancelled(signal);
    let result: SimulatorCommandResult;
    try { result = await runner.run(XCRUN, ["simctl", "list", "-j"], { signal, timeoutMs }); }
    catch { throw new SimulatorCreateError("SIMCTL_FAILED", "Simulator device state could not be read."); }
    if (commandUncertain(result) || result.exitCode !== 0 || signal?.aborted) {
      throw new SimulatorCreateError("SIMCTL_FAILED", "Simulator device state could not be read.");
    }
    try {
      const devices = parseSimulatorListJson(result.stdout).devices;
      if (new Set(devices.map(device => device.udid.toUpperCase())).size !== devices.length) throw new Error("duplicate UDID");
      return devices;
    }
    catch { throw new SimulatorCreateError("SIMCTL_FAILED", "Simulator device state was invalid."); }
  }

  async function findPendingMarker(markerName: string, signal?: AbortSignal): Promise<readonly SimulatorDevice[]> {
    requirePlatform();
    if (!MARKER.test(markerName)) throw new SimulatorCreateError("INVALID_ARGUMENT", "Simulator pending marker is invalid.");
    return (await catalog(signal)).filter(device => device.name === markerName);
  }

  async function deletePendingExact(input: SimulatorPendingDeviceIdentity, signal?: AbortSignal): Promise<void> {
    requirePlatform();
    validInput(input);
    const udid = exactUdid(input.udid);
    const expected = { ...input, udid };
    const before = (await catalog(signal, 10_000)).find(device => device.udid.toUpperCase() === udid);
    if (!before || !samePending(before, expected)) {
      throw new SimulatorCreateError("SIMULATOR_CREATE_CLEANUP_REQUIRED", "Pending Simulator identity changed; cleanup requires review.");
    }
    cancelled(signal);
    let deleted: SimulatorCommandResult;
    try { deleted = await runner.run(XCRUN, ["simctl", "delete", udid], { signal, timeoutMs: 10_000 }); }
    catch { throw new SimulatorCreateError("SIMULATOR_CREATE_CLEANUP_REQUIRED", "Pending Simulator cleanup outcome is unknown."); }
    if (commandUncertain(deleted) || signal?.aborted) {
      throw new SimulatorCreateError("SIMULATOR_CREATE_CLEANUP_REQUIRED", "Pending Simulator cleanup outcome is unknown.");
    }
    if (deleted.exitCode !== 0) throw new SimulatorCreateError("SIMULATOR_DELETE_FAILED", "Pending Simulator could not be deleted.");
    const after = (await catalog(signal, 10_000)).find(device => device.udid.toUpperCase() === udid);
    if (after !== undefined) throw new SimulatorCreateError("SIMULATOR_CREATE_CLEANUP_REQUIRED", "Pending Simulator deletion was not confirmed.");
  }

  async function renameExact(input: SimulatorPendingDeviceIdentity & { readonly name: string }, signal?: AbortSignal): Promise<void> {
    requirePlatform();
    validInput(input);
    const udid = exactUdid(input.udid);
    const name = checkedName(input.name);
    const expected = { ...input, udid };
    const before = (await catalog(signal)).find(device => device.udid.toUpperCase() === udid);
    if (before === undefined || before.runtimeIdentifier !== input.runtimeIdentifier
      || before.deviceTypeIdentifier !== input.deviceTypeIdentifier
      || before.name !== input.markerName && before.name !== name) {
      throw new SimulatorCreateError("SIMULATOR_RENAME_FAILED", "Pending Simulator identity changed before rename.");
    }
    if (before.name === name) return;
    cancelled(signal);
    let result: SimulatorCommandResult;
    try { result = await runner.run(XCRUN, ["simctl", "rename", udid, name], { signal, timeoutMs: 15_000 }); }
    catch { throw new SimulatorCreateError("SIMULATOR_RENAME_UNKNOWN", "Simulator rename outcome is unknown."); }
    if (commandUncertain(result) || signal?.aborted) throw new SimulatorCreateError("SIMULATOR_RENAME_UNKNOWN", "Simulator rename outcome is unknown.");
    if (result.exitCode !== 0) throw new SimulatorCreateError("SIMULATOR_RENAME_FAILED", "Simulator could not be renamed.");
    const after = (await catalog(signal)).find(device => device.udid.toUpperCase() === udid);
    if (after?.name !== name || after.runtimeIdentifier !== expected.runtimeIdentifier
      || after.deviceTypeIdentifier !== expected.deviceTypeIdentifier) {
      throw new SimulatorCreateError("SIMULATOR_RENAME_UNKNOWN", "Simulator rename could not be confirmed.");
    }
  }

  return {
    findPendingMarker,
    deletePendingExact,
    renameExact,
    async createExact(input, evidence, signal) {
      requirePlatform();
      validInput(input);
      cancelled(signal);
      try { evidence.arm(input.markerName); }
      catch { throw new SimulatorCreateError("CREATE_EVIDENCE_FAILED", "Simulator creation evidence could not be saved."); }
      let result: SimulatorCommandResult | undefined;
      try {
        result = await runner.run(XCRUN,
          ["simctl", "create", input.markerName, input.deviceTypeIdentifier, input.runtimeIdentifier],
          { signal, timeoutMs: 60_000 });
      } catch { /* The command may have changed CoreSimulator before failing. */ }
      const stdoutUdid = result?.stdout.trim().toUpperCase() ?? "";
      const commandSucceeded = result !== undefined && !commandUncertain(result) && result.exitCode === 0 && !signal?.aborted;
      if (commandSucceeded && UUID.test(stdoutUdid)) {
        try {
          const matching = await findPendingMarker(input.markerName);
          if (matching.length === 1 && samePending(matching[0]!, { ...input, udid: stdoutUdid })) {
            return { ...input, udid: stdoutUdid };
          }
        } catch { /* Keep evidence for the next bounded recovery attempt. */ }
        throw new SimulatorCreateError("SIMULATOR_CREATE_UNKNOWN", "Simulator creation could not be confirmed.");
      }

      // Cleanup is independent of caller cancellation. No marker is deleted based
      // only on a UUID printed by a failed command or on a partial catalog.
      try {
        const devices = await catalog(undefined, 10_000);
        const matching = devices.filter(device => device.name === input.markerName);
        if (matching.length === 1 && matching[0]!.runtimeIdentifier === input.runtimeIdentifier
          && matching[0]!.deviceTypeIdentifier === input.deviceTypeIdentifier) {
          await deletePendingExact({ ...input, udid: matching[0]!.udid });
          evidence.clear(input.markerName);
        } else if (matching.length === 0 && result !== undefined && !commandUncertain(result)
          && devices.every(device => device.udid.toUpperCase() !== stdoutUdid)) {
          evidence.clear(input.markerName);
        } else {
          throw new SimulatorCreateError("SIMULATOR_CREATE_CLEANUP_REQUIRED", "Pending Simulator cleanup requires review.");
        }
      } catch {
        throw new SimulatorCreateError("SIMULATOR_CREATE_CLEANUP_REQUIRED", "Pending Simulator cleanup requires review.");
      }
      if (signal?.aborted) throw new SimulatorCreateError("MUTATION_CANCELLED", "Simulator creation was cancelled.");
      throw new SimulatorCreateError("SIMULATOR_CREATE_FAILED", "Simulator could not be created.");
    }
  };
}
