import { spawn, type ChildProcess } from "node:child_process";

const XCODE_SELECT = "/usr/bin/xcode-select";
const XCODEBUILD = "/usr/bin/xcodebuild";
const XCRUN = "/usr/bin/xcrun";
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

export type SimulatorEnvironmentIssue =
  | "UNSUPPORTED_PLATFORM"
  | "XCODE_NOT_FOUND"
  | "SIMCTL_FAILED"
  | "INVALID_SIMCTL_OUTPUT"
  | "IOS_RUNTIME_NOT_FOUND"
  | "NO_SIMULATOR_DEVICES"
  | "PROBE_TIMEOUT"
  | "PROBE_ABORTED";

export interface SimulatorRuntimeInfo {
  readonly identifier: string;
  readonly name: string;
  readonly version: string | null;
  readonly buildVersion: string | null;
  readonly isAvailable: boolean;
}

export interface SimulatorDevice {
  readonly udid: string;
  readonly name: string;
  readonly state: string;
  readonly isAvailable: boolean;
  readonly runtimeIdentifier: string;
  readonly runtimeName: string;
  readonly runtimeVersion: string | null;
  readonly deviceTypeIdentifier: string | null;
  readonly lastBootedAt: string | null;
}

export interface SimulatorEnvironmentReport {
  readonly platform: NodeJS.Platform;
  readonly supported: boolean;
  readonly ready: boolean;
  readonly xcodeVersion: string | null;
  readonly runtimes: readonly SimulatorRuntimeInfo[];
  readonly devices: readonly SimulatorDevice[];
  readonly issue: SimulatorEnvironmentIssue | null;
  readonly error: string | null;
  readonly setupSteps: readonly string[];
}

export interface SimulatorCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly failed?: boolean;
  readonly timedOut?: boolean;
  readonly aborted?: boolean;
  readonly outputTruncated?: boolean;
}

export interface SimulatorCommandRunner {
  run(command: string, args: readonly string[], options?: { readonly signal?: AbortSignal; readonly timeoutMs?: number }): Promise<SimulatorCommandResult>;
}

export interface SimulatorEnvironmentRuntime {
  inspect(signal?: AbortSignal): Promise<SimulatorEnvironmentReport>;
}

export function createNodeSimulatorCommandRunner(): SimulatorCommandRunner {
  return {
    run(command, args, options) {
      const signal = options?.signal;
      const timeoutMs = options?.timeoutMs ?? 15_000;
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 180_000) {
        throw new RangeError("Simulator command timeout is invalid.");
      }
      if (signal?.aborted) return Promise.resolve({ stdout: "", stderr: "", exitCode: null, aborted: true });
      return new Promise<SimulatorCommandResult>((resolve) => {
        let child: ChildProcess;
        try {
          child = spawn(command, [...args], {
            shell: false,
            windowsHide: true,
            detached: process.platform === "darwin",
            stdio: ["ignore", "pipe", "pipe"]
          });
        } catch {
          resolve({ stdout: "", stderr: "", exitCode: null, failed: true });
          return;
        }
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        let bytes = 0;
        let outputTruncated = false;
        let settled = false;
        let timedOut = false;
        let aborted = false;
        let failed = false;
        let stopping = false;
        let forceTimer: ReturnType<typeof setTimeout> | undefined;
        const finish = (exitCode: number | null): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (forceTimer) clearTimeout(forceTimer);
          signal?.removeEventListener("abort", onAbort);
          resolve({
            stdout: Buffer.concat(stdout).toString("utf8"),
            stderr: Buffer.concat(stderr).toString("utf8"),
            exitCode, failed, timedOut, aborted, outputTruncated
          });
        };
        const kill = (): void => {
          if (process.platform === "darwin" && child.pid) {
            try { process.kill(-child.pid, "SIGKILL"); return; } catch { /* process already exited */ }
          }
          try { child.kill("SIGKILL"); } catch { /* process already exited */ }
        };
        const stop = (): void => {
          if (settled || stopping) return;
          stopping = true;
          clearTimeout(timer);
          kill();
          forceTimer = setTimeout(() => finish(null), 1_000);
        };
        const onAbort = (): void => { aborted = true; stop(); };
        const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
        const append = (parts: Buffer[], chunk: Buffer): void => {
          if (settled || outputTruncated) return;
          bytes += chunk.length;
          if (bytes > MAX_OUTPUT_BYTES) {
            outputTruncated = true;
            stop();
            return;
          }
          parts.push(Buffer.from(chunk));
        };
        child.stdout?.on("data", (chunk: Buffer) => append(stdout, chunk));
        child.stderr?.on("data", (chunk: Buffer) => append(stderr, chunk));
        child.once("error", () => { failed = true; finish(null); });
        child.once("close", (code) => finish(code));
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) onAbort();
      });
    }
  };
}

function unavailable(platform: NodeJS.Platform, issue: SimulatorEnvironmentIssue, error: string, setupSteps: readonly string[], partial: Partial<SimulatorEnvironmentReport> = {}): SimulatorEnvironmentReport {
  return { platform, supported: platform === "darwin", ready: false, xcodeVersion: null,
    runtimes: [], devices: [], issue, error, setupSteps, ...partial };
}

function commandIssue(result: SimulatorCommandResult, fallback: SimulatorEnvironmentIssue): SimulatorEnvironmentIssue {
  if (result.aborted) return "PROBE_ABORTED";
  if (result.timedOut) return "PROBE_TIMEOUT";
  return fallback;
}

function commandFailed(result: SimulatorCommandResult): boolean {
  return result.exitCode !== 0 || result.failed === true || result.timedOut === true || result.aborted === true || result.outputTruncated === true;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function shortString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 512 ? value : null;
}

export function parseSimulatorListJson(text: string): { readonly runtimes: readonly SimulatorRuntimeInfo[]; readonly devices: readonly SimulatorDevice[] } {
  const input: unknown = JSON.parse(text);
  if (!record(input) || !Array.isArray(input["runtimes"]) || !record(input["devices"])) {
    throw new Error("simctl list result has no runtime and device catalog.");
  }
  const runtimeById = new Map<string, SimulatorRuntimeInfo>();
  for (const value of input["runtimes"]) {
    if (!record(value)) continue;
    const identifier = shortString(value["identifier"]);
    const name = shortString(value["name"]);
    if (!identifier || !name || !(identifier.includes(".SimRuntime.iOS-") || name.startsWith("iOS ") || value["platform"] === "iOS")) continue;
    const runtime: SimulatorRuntimeInfo = {
      identifier, name, version: shortString(value["version"]),
      buildVersion: shortString(value["buildversion"]) ?? shortString(value["buildVersion"]),
      isAvailable: typeof value["isAvailable"] === "boolean" ? value["isAvailable"] : !shortString(value["availabilityError"])
    };
    const previous = runtimeById.get(identifier);
    if (!previous || (!previous.isAvailable && runtime.isAvailable)) runtimeById.set(identifier, runtime);
  }
  const devices: SimulatorDevice[] = [];
  for (const [identifier, values] of Object.entries(input["devices"])) {
    const runtime = runtimeById.get(identifier);
    if (!runtime || !Array.isArray(values)) continue;
    for (const value of values) {
      if (!record(value)) continue;
      const udid = shortString(value["udid"]);
      const name = shortString(value["name"]);
      if (!udid || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(udid) || !name) continue;
      devices.push({
        udid, name, state: shortString(value["state"]) ?? "Unknown",
        isAvailable: runtime.isAvailable && (typeof value["isAvailable"] === "boolean" ? value["isAvailable"] : !shortString(value["availabilityError"])),
        runtimeIdentifier: runtime.identifier, runtimeName: runtime.name, runtimeVersion: runtime.version,
        deviceTypeIdentifier: shortString(value["deviceTypeIdentifier"]), lastBootedAt: shortString(value["lastBootedAt"])
      });
    }
  }
  const runtimes = [...runtimeById.values()].sort((a, b) => b.name.localeCompare(a.name) || a.identifier.localeCompare(b.identifier));
  devices.sort((a, b) => Number(b.state === "Booted") - Number(a.state === "Booted") || b.runtimeName.localeCompare(a.runtimeName) || a.name.localeCompare(b.name) || a.udid.localeCompare(b.udid));
  return { runtimes, devices };
}

export function createSimulatorEnvironmentRuntime(options: { readonly platform?: NodeJS.Platform; readonly runner?: SimulatorCommandRunner } = {}): SimulatorEnvironmentRuntime {
  const platform = options.platform ?? process.platform;
  const runner = options.runner ?? createNodeSimulatorCommandRunner();
  return {
    async inspect(signal) {
      if (platform !== "darwin") return unavailable(platform, "UNSUPPORTED_PLATFORM", "iOS Simulator is available only for local macOS sessions.", ["Open this task on a macOS host with Xcode installed."]);
      const selected = await runner.run(XCODE_SELECT, ["-p"], { signal });
      if (commandFailed(selected) || !selected.stdout.trim()) return unavailable(platform, commandIssue(selected, "XCODE_NOT_FOUND"), "Xcode command line tools are unavailable.", ["Install Xcode and select its developer tools."]);
      const version = await runner.run(XCODEBUILD, ["-version"], { signal });
      if (commandFailed(version)) return unavailable(platform, commandIssue(version, "XCODE_NOT_FOUND"), "Xcode could not report its version.", ["Open or repair Xcode and select its developer tools."]);
      const xcodeVersion = version.stdout.trim().slice(0, 256) || null;
      const listed = await runner.run(XCRUN, ["simctl", "list", "-j"], { signal });
      if (commandFailed(listed)) return unavailable(platform, commandIssue(listed, "SIMCTL_FAILED"), "Simulator device discovery failed.", ["Check the installed iOS platform in Xcode and retry."], { xcodeVersion });
      let parsed: ReturnType<typeof parseSimulatorListJson>;
      try { parsed = parseSimulatorListJson(listed.stdout); }
      catch { return unavailable(platform, "INVALID_SIMCTL_OUTPUT", "Simulator device discovery returned invalid data.", ["Restart Xcode and retry discovery."], { xcodeVersion }); }
      if (!parsed.runtimes.some(runtime => runtime.isAvailable)) return unavailable(platform, "IOS_RUNTIME_NOT_FOUND", "No available iOS Simulator runtime is installed.", ["Install an iOS Simulator runtime in Xcode Settings."], { xcodeVersion, ...parsed });
      if (!parsed.devices.some(device => device.isAvailable)) return unavailable(platform, "NO_SIMULATOR_DEVICES", "No available simulated iPhone or iPad exists.", ["Create or repair a simulator in Xcode Devices and Simulators."], { xcodeVersion, ...parsed });
      return { platform, supported: true, ready: true, xcodeVersion, ...parsed, issue: null, error: null, setupSteps: [] };
    }
  };
}
