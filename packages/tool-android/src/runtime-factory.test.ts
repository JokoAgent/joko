import { describe, expect, it, vi } from "vitest";

import type {
  AndroidCommandRequest,
  AndroidCommandResult,
  AndroidCommandRunner
} from "./process-runner.js";
import { AndroidAutomationRuntimeFactory } from "./runtime-factory.js";
import { AndroidAutomationRuntime } from "./runtime.js";

describe("AndroidAutomationRuntimeFactory", () => {
  it("applies owner settings without exposing runtime internals", async () => {
    const runner = functionalRunner(async (request) => {
      if (request.arguments?.[0] === "version") return result("Android Debug Bridge 35");
      if (request.arguments?.[0] === "devices") {
        return result("List of devices attached\nserial2 device model:Pixel\n");
      }
      throw new Error("Unexpected command");
    });
    const factory = new AndroidAutomationRuntimeFactory({
      platform: "linux",
      homeDirectory: "/home/tester",
      runner,
      portProbe: async () => true,
      pathExists: () => false
    });
    const runtime = factory.create({
      defaultDeviceSerial: "serial2",
      adbPathOverride: "/home/tester/private/adb"
    });

    expect(runtime.descriptor()).toEqual({
      executablePath: "[PATH]/private/adb",
      pathSource: "custom",
      platform: "linux",
      architecture: process.arch
    });
    await expect(runtime.status()).resolves.toMatchObject({
      configuredDefaultDeviceSerial: "serial2",
      selectedDeviceSerial: "serial2",
      installation: { pathSource: "custom" }
    });
  });

  it("creates the replacement before safely disposing the previous runtime", async () => {
    const factory = new AndroidAutomationRuntimeFactory({
      platform: "linux",
      homeDirectory: "/home/tester",
      runner: functionalRunner(async () => result("")),
      portProbe: async () => false,
      pathExists: () => false
    });
    const current = factory.create({ adbPathOverride: "/home/tester/first/adb" });
    const dispose = vi.spyOn(current, "dispose");

    const replacement = await factory.reconfigure(current, {
      adbPathOverride: "/home/tester/second/adb",
      defaultDeviceSerial: "serial2"
    });

    expect(dispose).toHaveBeenCalledTimes(1);
    expect(replacement).toBeInstanceOf(AndroidAutomationRuntime);
    expect(replacement.descriptor()).toMatchObject({
      executablePath: "[PATH]/second/adb",
      pathSource: "custom"
    });
    await expect(current.listDevices()).rejects.toThrow(/closed/iu);
  });

  it("treats null and blank owner settings as unset", () => {
    const factory = new AndroidAutomationRuntimeFactory({
      platform: "linux",
      homeDirectory: "/home/tester",
      runner: functionalRunner(async () => result("")),
      portProbe: async () => false,
      pathExists: () => false
    });

    expect(factory.create({ adbPathOverride: "  ", defaultDeviceSerial: null }).descriptor())
      .toMatchObject({ executablePath: "adb", pathSource: "fallback" });
  });
});

describe("Android runtime activity state", () => {
  it("reports checking for non-mutating probes and preparing only while the preparer runs", async () => {
    let releasePreparation: (() => void) | undefined;
    const preparationGate = new Promise<void>((resolveGate) => { releasePreparation = resolveGate; });
    let reportPreparing: (() => void) | undefined;
    const preparingSeen = new Promise<void>((resolvePreparing) => { reportPreparing = resolvePreparing; });
    const states: string[] = [];
    const runner = functionalRunner(async (request) => {
      if (request.command === "adb") throw new Error("not found");
      if (request.arguments?.[0] === "version") return result("Android Debug Bridge 36");
      if (request.arguments?.[0] === "devices") return result("List of devices attached\n");
      throw new Error("Unexpected command");
    });
    const runtime = new AndroidAutomationRuntime({
      platform: "linux",
      homeDirectory: "/home/tester",
      preparedExecutablePath: "/home/tester/prepared/adb",
      preparer: {
        prepare: async () => {
          await preparationGate;
          return { executablePath: "/home/tester/prepared/adb" };
        }
      },
      runner,
      pathExists: () => false,
      portProbe: async () => true,
      onActivityStateChange: (state) => {
        states.push(state);
        if (state === "preparing") reportPreparing?.();
      }
    });

    const pending = runtime.status();
    await preparingSeen;
    expect(runtime.activityState()).toBe("preparing");
    expect(states).toEqual(["checking", "preparing"]);
    releasePreparation?.();

    await expect(pending).resolves.toMatchObject({
      activityState: "idle",
      installation: {
        state: "installed",
        pathSource: "prepared",
        preparation: { attempted: true, ready: true }
      }
    });
    expect(states).toEqual(["checking", "preparing", "checking", "idle"]);
    expect(runtime.activityState()).toBe("idle");
  });
});

function functionalRunner(
  implementation: (request: AndroidCommandRequest) => Promise<AndroidCommandResult>
): AndroidCommandRunner {
  return { run: vi.fn(implementation) };
}

function result(stdout: string, stderr = "", exitCode = 0): AndroidCommandResult {
  return {
    stdout,
    stderr,
    stdoutTruncated: false,
    stderrTruncated: false,
    exitCode,
    signal: null
  };
}
